require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');

// Initialize bot with options
const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN, { 
    polling: {
        interval: 300,
        params: {
            timeout: 10
        }
    },
    onlyFirstMatch: true,
    filepath: false
});

// Initialize Gemini AI
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

// File to store transactions
const TRANSACTIONS_FILE = 'transactions.json';

// Initialize transactions file if it doesn't exist
if (!fs.existsSync(TRANSACTIONS_FILE)) {
    fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify([]));
}

// Load transactions
function loadTransactions() {
    return JSON.parse(fs.readFileSync(TRANSACTIONS_FILE, 'utf8'));
}

// Save transactions
function saveTransactions(transactions) {
    fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify(transactions, null, 2));
}

// Helper function to format currency
function formatCurrency(amount) {
    return new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' }).format(amount);
}

// Hàm chuyển đổi định dạng tiền tệ dạng k, m thành số
function parseMoneyString(str) {
    // Chuyển tất cả về chữ thường
    str = str.toLowerCase().trim();
    
    // Tìm số và đơn vị
    const match = str.match(/^[+-]?(\d+)(k|m)?$/);
    if (!match) return null;

    let [, number, unit] = match;
    number = parseInt(number);

    // Chuyển đổi theo đơn vị
    switch (unit) {
        case 'k':
            return number * 1000;
        case 'm':
            return number * 1000000;
        default:
            return number;
    }
}

// Rate limiting
const userCooldowns = new Map();
const COOLDOWN_TIME = 2000; // 2 seconds cooldown

function isUserInCooldown(userId) {
    if (!userCooldowns.has(userId)) {
        return false;
    }
    const lastMessageTime = userCooldowns.get(userId);
    return Date.now() - lastMessageTime < COOLDOWN_TIME;
}

function updateUserCooldown(userId) {
    userCooldowns.set(userId, Date.now());
}

// Helper function to get week number
function getWeekNumber(date) {
    const firstDayOfYear = new Date(date.getFullYear(), 0, 1);
    const pastDaysOfYear = (date - firstDayOfYear) / 86400000;
    return Math.ceil((pastDaysOfYear + firstDayOfYear.getDay() + 1) / 7);
}

// Helper function to format date ranges
function formatDateRange(start, end) {
    return `${start.toLocaleDateString('vi-VN')} - ${end.toLocaleDateString('vi-VN')}`;
}

// Command handlers
bot.onText(/^\/start$/, (msg) => {
    const chatId = msg.chat.id;
    const welcome = `Xin chào! Tôi là Bot Quản lý Thu Chi 💰

Cách sử dụng:
1️⃣ Ghi khoản chi (mặc định): 
    10k cafe
    1m tien nha
    -10k cafe

2️⃣ Ghi khoản thu (thêm dấu +): 
    +10k luong
    +1m thuong

Các lệnh:
📊 /xem - Xem sổ thu chi
📈 /thongke - Xem báo cáo tổng quan
🤔 /phanTich - Phân tích dữ liệu tài chính
❌ /xoa - Xóa giao dịch
🗑️ /xoahet - Xóa tất cả lịch sử

💡 Lưu ý: 
- k = nghìn (10k = 10,000đ)
- m = triệu (1m = 1,000,000đ)`;
    bot.sendMessage(chatId, welcome, { parse_mode: 'HTML' });
});

// Remove old handler
bot.removeTextListener(/^[+-]?\d+[km]?\s+.+$/i);

// Handle regular messages for transaction extraction
bot.onText(/^(?!\/)[+-]?\d+[km]?\s+.+$/i, async (msg) => {
    const chatId = msg.chat.id;
    const userId = msg.from.id;

    // Check cooldown
    if (isUserInCooldown(userId)) {
        return;
    }
    updateUserCooldown(userId);

    const text = msg.text.trim();
    const parts = text.split(/\s+/);
    const moneyStr = parts[0];
    const note = parts.slice(1).join(' ');

    // Xử lý số tiền
    const amount = parseMoneyString(moneyStr);
    if (!amount) {
        bot.sendMessage(chatId, '❌ Số tiền không hợp lệ\nVí dụ: 10k, 100k, 1m');
        return;
    }

    // Xác định loại giao dịch
    const type = moneyStr.startsWith('+') ? 'income' : 'expense';

    try {
        // Lưu giao dịch
        const transactions = loadTransactions();
        const newTransaction = {
            sotien: amount,
            ghichu: note,
            loai: type === 'income' ? 'thu' : 'chi',
            ngay: new Date().toISOString()
        };
        
        transactions.push(newTransaction);
        saveTransactions(transactions);

        // Tính tổng thu chi
        const totalIncome = transactions
            .filter(t => t.loai === 'thu')
            .reduce((sum, t) => sum + t.sotien, 0);

        const totalExpense = transactions
            .filter(t => t.loai === 'chi')
            .reduce((sum, t) => sum + t.sotien, 0);

        // Send response with formatted amount and totals
        const responseMsg = `✅ Đã ghi ${newTransaction.loai === 'thu' ? 'khoản thu 💰' : 'khoản chi 💸'}: ${formatCurrency(newTransaction.sotien)}\n📝 Ghi chú: ${newTransaction.ghichu}\n\n` + 
            `📊 Tổng kết:\n` +
            `💰 Tổng thu: ${formatCurrency(totalIncome)}\n` +
            `💸 Tổng chi: ${formatCurrency(totalExpense)}\n` +
            `💎 Số dư: ${formatCurrency(totalIncome - totalExpense)}`;
        
        await bot.sendMessage(chatId, responseMsg);
    } catch (error) {
        console.error('Error:', error);
        if (error.response && error.response.statusCode === 401) {
            console.error('Telegram token is invalid');
            process.exit(1);
        }
        bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi xử lý giao dịch. Vui lòng thử lại.');
    }
});

// View transactions
bot.onText(/\/xem/, (msg) => {
    const chatId = msg.chat.id;
    const transactions = loadTransactions();

    if (transactions.length === 0) {
        bot.sendMessage(chatId, '📝 Chưa có giao dịch nào được ghi nhận');
        return;
    }

    let message = '📊 SỔ THU CHI\n\n';
    transactions.forEach((t, i) => {
        const date = new Date(t.ngay).toLocaleDateString('vi-VN');
        const type = t.loai === 'thu' ? '💰 Thu' : '💸 Chi';
        message += `${i + 1}. ${type}: ${formatCurrency(t.sotien)}\n📝 ${t.ghichu}\n📅 ${date}\n\n`;
    });

    bot.sendMessage(chatId, message);
});

// Statistics
bot.onText(/\/thongke/, (msg) => {
    const chatId = msg.chat.id;
    const transactions = loadTransactions();

    if (transactions.length === 0) {
        bot.sendMessage(chatId, '❌ Chưa có giao dịch nào.');
        return;
    }

    // Calculate totals
    const totalIncome = transactions
        .filter(t => t.loai === 'thu')
        .reduce((sum, t) => sum + t.sotien, 0);

    const totalExpense = transactions
        .filter(t => t.loai === 'chi')
        .reduce((sum, t) => sum + t.sotien, 0);

    // Group transactions by month
    const monthlyStats = {};
    const weeklyStats = {};
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth();

    transactions.forEach(t => {
        const date = new Date(t.ngay);
        const month = date.getMonth();
        const week = getWeekNumber(date);
        const monthKey = `${date.getFullYear()}-${month + 1}`;
        const weekKey = `${date.getFullYear()}-W${week}`;

        // Initialize if not exists
        if (!monthlyStats[monthKey]) {
            monthlyStats[monthKey] = { income: 0, expense: 0 };
        }
        if (!weeklyStats[weekKey]) {
            weeklyStats[weekKey] = { income: 0, expense: 0, startDate: new Date(date) };
        }

        // Add to monthly stats
        if (t.loai === 'thu') {
            monthlyStats[monthKey].income += t.sotien;
        } else {
            monthlyStats[monthKey].expense += t.sotien;
        }

        // Add to weekly stats
        if (t.loai === 'thu') {
            weeklyStats[weekKey].income += t.sotien;
        } else {
            weeklyStats[weekKey].expense += t.sotien;
        }
    });

    // Create message
    let message = `📊 BÁO CÁO THU CHI CỦA PHI\n\n`;
    message += `💰 Tổng thu: ${formatCurrency(totalIncome)}\n`;
    message += `💸 Tổng chi: ${formatCurrency(totalExpense)}\n`;
    message += `💎 Số dư: ${formatCurrency(totalIncome - totalExpense)}\n\n`;

    // Add monthly breakdown (last 3 months)
    message += `📅 THỐNG KÊ THEO THÁNG\n`;
    const monthKeys = Object.keys(monthlyStats)
        .sort((a, b) => b.localeCompare(a))
        .slice(0, 3);

    monthKeys.forEach(key => {
        const [year, month] = key.split('-');
        const stats = monthlyStats[key];
        message += `\nTháng ${month}/${year}:\n`;
        message += `  💰 Thu: ${formatCurrency(stats.income)}\n`;
        message += `  💸 Chi: ${formatCurrency(stats.expense)}\n`;
        message += `  💎 Còn: ${formatCurrency(stats.income - stats.expense)}\n`;
    });

    // Add weekly breakdown (last 2 weeks)
    message += `\n📆 THỐNG KÊ THEO TUẦN\n`;
    const weekKeys = Object.keys(weeklyStats)
        .sort((a, b) => b.localeCompare(a))
        .slice(0, 2);

    weekKeys.forEach(key => {
        const stats = weeklyStats[key];
        const startDate = new Date(stats.startDate);
        const endDate = new Date(startDate);
        endDate.setDate(startDate.getDate() + 6);
        
        message += `\n${formatDateRange(startDate, endDate)}:\n`;
        message += `  💰 Thu: ${formatCurrency(stats.income)}\n`;
        message += `  💸 Chi: ${formatCurrency(stats.expense)}\n`;
        message += `  💎 Còn: ${formatCurrency(stats.income - stats.expense)}\n`;
    });

    bot.sendMessage(chatId, message);
});

// AI Analysis
bot.onText(/\/phanTich/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        const transactions = loadTransactions();
        if (transactions.length === 0) {
            bot.sendMessage(chatId, '❌ Chưa có giao dịch nào để phân tích');
            return;
        }

        // Tính tổng thu chi
        const totalIncome = transactions
            .filter(t => t.loai === 'thu')
            .reduce((sum, t) => sum + t.sotien, 0);

        const totalExpense = transactions
            .filter(t => t.loai === 'chi')
            .reduce((sum, t) => sum + t.sotien, 0);

        // Phân loại giao dịch theo ngày
        const transactionsByDate = {};
        transactions.forEach(t => {
            const date = new Date(t.ngay).toLocaleDateString('vi-VN');
            if (!transactionsByDate[date]) {
                transactionsByDate[date] = [];
            }
            transactionsByDate[date].push(t);
        });

        // Tạo context cho AI
        const context = `Phân tích các giao dịch tài chính sau:

TỔNG QUAN:
- Tổng thu: ${formatCurrency(totalIncome)}
- Tổng chi: ${formatCurrency(totalExpense)}
- Số dư: ${formatCurrency(totalIncome - totalExpense)}

CHI TIẾT GIAO DỊCH THEO NGÀY:
${Object.entries(transactionsByDate).map(([date, txs]) => `
${date}:
${txs.map(t => `- ${t.loai === 'thu' ? 'Thu' : 'Chi'}: ${formatCurrency(t.sotien)} - ${t.ghichu}`).join('\n')}`).join('\n')}

Hãy phân tích và trả lời các câu hỏi sau (trả lời bằng tiếng Việt):

1. Tình hình thu chi:
- Thu nhập và chi tiêu có cân đối không?
- Tỷ lệ thu/chi như thế nào?

2. Các khoản chi tiêu:
- Những khoản chi tiêu lớn nhất?
- Có khoản chi tiêu bất thường không?
- Chi tiêu tập trung vào những mục nào?

3. Xu hướng:
- Xu hướng chi tiêu theo thời gian?
- Có ngày nào chi tiêu nhiều bất thường không?

4. Lời khuyên:
- Cần điều chỉnh gì để cải thiện tình hình tài chính?
- Các gợi ý để tiết kiệm và quản lý chi tiêu tốt hơn?

Trả lời ngắn gọn, súc tích và dễ hiểu.`;

        // Gửi tin nhắn chờ
        const waitingMsg = await bot.sendMessage(chatId, '🤔 Đang phân tích dữ liệu...');

        // Gọi Gemini API
        const model = genAI.getGenerativeModel({ model: "gemini-pro" });
        const result = await model.generateContent(context);
        const response = await result.response;
        const analysis = response.text();

        // Xóa tin nhắn chờ
        await bot.deleteMessage(chatId, waitingMsg.message_id);

        // Gửi kết quả phân tích
        await bot.sendMessage(chatId, `📊 PHÂN TÍCH TÀI CHÍNH\n\n${analysis}`);
    } catch (error) {
        console.error('Error:', error);
        bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi phân tích dữ liệu. Vui lòng thử lại sau.');
    }
});

// Command to delete a transaction
bot.onText(/\/xoa(\s+\d+)?$/, (msg, match) => {
    const chatId = msg.chat.id;
    const index = match[1] ? parseInt(match[1].trim()) - 1 : null;

    try {
        const transactions = loadTransactions();

        if (transactions.length === 0) {
            bot.sendMessage(chatId, '❌ Không có giao dịch nào để xóa.');
            return;
        }

        if (index === null) {
            // Show list of transactions with numbers
            let message = '📝 Danh sách giao dịch:\n\n';
            transactions.forEach((t, i) => {
                const date = new Date(t.ngay).toLocaleDateString('vi-VN');
                const amount = formatCurrency(t.sotien);
                message += `${i + 1}. ${date}: ${amount} - ${t.ghichu}\n`;
            });
            message += '\n💡 Để xóa, hãy gửi "/xoa [số thứ tự]"\nVí dụ: /xoa 1';
            bot.sendMessage(chatId, message);
            return;
        }

        if (index < 0 || index >= transactions.length) {
            bot.sendMessage(chatId, '❌ Số thứ tự không hợp lệ.');
            return;
        }

        // Remove the transaction
        const deleted = transactions.splice(index, 1)[0];
        saveTransactions(transactions);

        const date = new Date(deleted.ngay).toLocaleDateString('vi-VN');
        const amount = formatCurrency(deleted.sotien);
        bot.sendMessage(chatId, `✅ Đã xóa giao dịch:\n${date}: ${amount} - ${deleted.ghichu}`);
    } catch (error) {
        console.error('Error in delete command:', error);
        bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi xóa giao dịch.');
    }
});

// Command to clear all transaction history
bot.onText(/\/xoahet/, async (msg) => {
    const chatId = msg.chat.id;
    
    try {
        const transactions = loadTransactions();
        
        if (transactions.length === 0) {
            bot.sendMessage(chatId, '❌ Không có giao dịch nào để xóa.');
            return;
        }

        // Ask for confirmation with inline keyboard
        await bot.sendMessage(
            chatId,
            `⚠️ Bạn có chắc chắn muốn xóa tất cả ${transactions.length} giao dịch không?`,
            {
                reply_markup: {
                    inline_keyboard: [
                        [
                            { text: '✅ Có, xóa hết', callback_data: 'confirm_delete_all' },
                            { text: '❌ Không, hủy bỏ', callback_data: 'cancel_delete_all' }
                        ]
                    ]
                }
            }
        );

    } catch (error) {
        console.error('Error in clear history command:', error);
        bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi xóa lịch sử.');
    }
});

// Handle inline keyboard callbacks
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;

    try {
        if (callbackQuery.data === 'confirm_delete_all') {
            const transactions = loadTransactions();
            const totalAmount = transactions.reduce((sum, t) => sum + t.sotien, 0);
            const incomeAmount = transactions.reduce((sum, t) => t.loai === 'thu' ? sum + t.sotien : sum, 0);
            const expenseAmount = transactions.reduce((sum, t) => t.loai === 'chi' ? sum + t.sotien : sum, 0);
            
            // Clear all transactions
            saveTransactions([]);
            
            const message = `✅ Đã xóa tất cả ${transactions.length} giao dịch:\n\n` +
                          `📊 Tổng quan đã xóa:\n` +
                          `💰 Tổng thu: ${formatCurrency(incomeAmount)}\n` +
                          `💸 Tổng chi: ${formatCurrency(expenseAmount)}\n` +
                          `💵 Số dư: ${formatCurrency(totalAmount)}`;
            
            await bot.editMessageText(message, {
                chat_id: chatId,
                message_id: messageId
            });
        } else if (callbackQuery.data === 'cancel_delete_all') {
            await bot.editMessageText('❌ Đã hủy xóa lịch sử.', {
                chat_id: chatId,
                message_id: messageId
            });
        }
        
        // Answer callback query to remove loading state
        await bot.answerCallbackQuery(callbackQuery.id);
    } catch (error) {
        console.error('Error in callback query:', error);
        bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi xử lý yêu cầu.');
    }
});

// Error handling
bot.on('polling_error', (error) => {
    if (error.response && error.response.statusCode === 401) {
        console.error('Telegram token is invalid');
        process.exit(1);
    }
    console.error('Polling error:', error);
});
