require('dotenv').config();
const TelegramBot = require('node-telegram-bot-api');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const fs = require('fs');
const ExcelJS = require('exceljs');
const schedule = require('node-schedule');

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

// Constants for files
const TRANSACTIONS_FILE = 'transactions.json';
const ACCOUNTS_FILE = 'accounts.json';
const REMINDERS_FILE = 'reminders.json';

// Initialize files if they don't exist
if (!fs.existsSync(TRANSACTIONS_FILE)) {
    fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify([]));
}
if (!fs.existsSync(ACCOUNTS_FILE)) {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify([]));
}
if (!fs.existsSync(REMINDERS_FILE)) {
    fs.writeFileSync(REMINDERS_FILE, JSON.stringify([]));
}

// Load transactions
function loadTransactions() {
    return JSON.parse(fs.readFileSync(TRANSACTIONS_FILE, 'utf8'));
}

// Save transactions
function saveTransactions(transactions) {
    fs.writeFileSync(TRANSACTIONS_FILE, JSON.stringify(transactions, null, 2));
}

// Load accounts
function loadAccounts() {
    return JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'));
}

// Save accounts
function saveAccounts(accounts) {
    fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2));
}

// Load reminders
function loadReminders() {
    return JSON.parse(fs.readFileSync(REMINDERS_FILE, 'utf8'));
}

// Save reminders
function saveReminders(reminders) {
    fs.writeFileSync(REMINDERS_FILE, JSON.stringify(reminders, null, 2));
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

Các lệnh cơ bản:
📊 /xem - Xem sổ thu chi
📈 /thongke - Xem báo cáo tổng quan
🤔 /phanTich - Phân tích dữ liệu tài chính
❌ /xoa - Xóa giao dịch
🗑️ /xoahet - Xóa tất cả lịch sử

Quản lý tài khoản:
💳 /taikhoan - Xem danh sách tài khoản
➕ /themtk - Thêm tài khoản mới (VD: /themtk Ví 100k)
✏️ /capnhattk - Cập nhật số dư (VD: /capnhattk Ví 150k)
❌ /xoatk - Xóa tài khoản (VD: /xoatk Ví)

Tìm kiếm và Lọc:
🔍 /timkiem [từ khóa] - Tìm giao dịch
📅 /loc [số ngày] [loại] - Lọc theo thời gian

Tiện ích:
⏰ /nhacnho - Quản lý nhắc nhở thanh toán định kỳ
📊 /xuatexcel - Xuất báo cáo Excel

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
        // Kiểm tra tài khoản
        const accounts = loadAccounts();
        if (accounts.length === 0) {
            bot.sendMessage(chatId, '❌ Vui lòng tạo ít nhất một tài khoản trước khi ghi chép thu chi.\nSử dụng lệnh /themtk để thêm tài khoản.');
            return;
        }

        // Nếu chỉ có một tài khoản, sử dụng tài khoản đó
        // Nếu có nhiều tài khoản, hỏi người dùng muốn sử dụng tài khoản nào
        let selectedAccount;
        if (accounts.length === 1) {
            selectedAccount = accounts[0];
            // Cập nhật số dư tài khoản
            selectedAccount.sodu += (type === 'income' ? amount : -amount);
            saveAccounts(accounts);
        } else {
            // Tạo keyboard với các tài khoản
            const keyboard = accounts.map(acc => [{
                text: `${acc.ten} (${formatCurrency(acc.sodu)})`,
                callback_data: `select_account:${acc.ten}:${amount}:${type}:${note}`
            }]);

            await bot.sendMessage(chatId, 
                '📝 Chọn tài khoản để ghi nhận giao dịch:', 
                {
                    reply_markup: {
                        inline_keyboard: keyboard
                    }
                }
            );
            return;
        }

        // Lưu giao dịch
        const transactions = loadTransactions();
        const newTransaction = {
            sotien: amount,
            ghichu: note,
            loai: type === 'income' ? 'thu' : 'chi',
            ngay: new Date().toISOString(),
            taikhoan: selectedAccount.ten
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

        // Gửi thông báo
        let message = `✅ Đã ghi nhận giao dịch:\n`;
        message += `${type === 'income' ? '💰 Thu' : '💸 Chi'}: ${formatCurrency(amount)}\n`;
        message += `📝 Ghi chú: ${note}\n`;
        message += `💳 Tài khoản: ${selectedAccount.ten}\n`;
        message += `💵 Số dư tài khoản: ${formatCurrency(selectedAccount.sodu)}\n\n`;
        message += `📊 Tổng thu: ${formatCurrency(totalIncome)}\n`;
        message += `📊 Tổng chi: ${formatCurrency(totalExpense)}\n`;
        message += `💎 Còn lại: ${formatCurrency(totalIncome - totalExpense)}`;

        bot.sendMessage(chatId, message);
    } catch (error) {
        console.error('Error in transaction handler:', error);
        bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi ghi nhận giao dịch.');
    }
});

// Handle account selection for transactions
bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;

    try {
        if (data.startsWith('select_account:')) {
            const [, accountName, amount, type, ...noteParts] = data.split(':');
            const note = noteParts.join(':');
            const accounts = loadAccounts();
            const selectedAccount = accounts.find(a => a.ten === accountName);

            if (!selectedAccount) {
                await bot.sendMessage(chatId, '❌ Không tìm thấy tài khoản này!');
                return;
            }

            // Cập nhật số dư tài khoản
            selectedAccount.sodu += (type === 'income' ? Number(amount) : -Number(amount));
            saveAccounts(accounts);

            // Lưu giao dịch
            const transactions = loadTransactions();
            const newTransaction = {
                sotien: Number(amount),
                ghichu: note,
                loai: type === 'income' ? 'thu' : 'chi',
                ngay: new Date().toISOString(),
                taikhoan: accountName
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

            // Cập nhật tin nhắn
            let message = `✅ Đã ghi nhận giao dịch:\n`;
            message += `${type === 'income' ? '💰 Thu' : '💸 Chi'}: ${formatCurrency(Number(amount))}\n`;
            message += `📝 Ghi chú: ${note}\n`;
            message += `💳 Tài khoản: ${accountName}\n`;
            message += `💵 Số dư tài khoản: ${formatCurrency(selectedAccount.sodu)}\n\n`;
            message += `📊 Tổng thu: ${formatCurrency(totalIncome)}\n`;
            message += `📊 Tổng chi: ${formatCurrency(totalExpense)}\n`;
            message += `💎 Còn lại: ${formatCurrency(totalIncome - totalExpense)}`;

            await bot.editMessageText(message, {
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
        message += `${i + 1}. ${type}: ${formatCurrency(t.sotien)}\n📝 ${t.ghichu}\n💳 ${t.taikhoan}\n📅 ${date}\n\n`;
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

// Command to add new account
bot.onText(/\/themtk (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const input = match[1].split(' ');
    
    if (input.length < 2) {
        bot.sendMessage(chatId, '❌ Vui lòng nhập theo định dạng: /themtk [tên tài khoản] [số dư]\nVí dụ: /themtk Ví 100k');
        return;
    }

    const balance = parseMoneyString(input[input.length - 1]);
    if (balance === null) {
        bot.sendMessage(chatId, '❌ Số dư không hợp lệ. Vui lòng sử dụng định dạng: 100k, 1m, ...');
        return;
    }

    const name = input.slice(0, -1).join(' ');
    const accounts = loadAccounts();
    
    // Check if account already exists
    if (accounts.some(a => a.ten.toLowerCase() === name.toLowerCase())) {
        bot.sendMessage(chatId, '❌ Tài khoản này đã tồn tại!');
        return;
    }

    accounts.push({
        ten: name,
        sodu: balance
    });
    
    saveAccounts(accounts);
    bot.sendMessage(chatId, `✅ Đã thêm tài khoản "${name}" với số dư ${formatCurrency(balance)}`);
});

// Command to view accounts
bot.onText(/\/taikhoan/, (msg) => {
    const chatId = msg.chat.id;
    const accounts = loadAccounts();

    if (accounts.length === 0) {
        bot.sendMessage(chatId, '❌ Chưa có tài khoản nào.');
        return;
    }

    let message = '💳 DANH SÁCH TÀI KHOẢN\n\n';
    let totalBalance = 0;

    accounts.forEach((account, index) => {
        message += `${index + 1}. ${account.ten}\n`;
        message += `   💰 Số dư: ${formatCurrency(account.sodu)}\n\n`;
        totalBalance += account.sodu;
    });

    message += `\n💵 TỔNG SỐ DƯ: ${formatCurrency(totalBalance)}`;
    bot.sendMessage(chatId, message);
});

// Command to delete account
bot.onText(/\/xoatk (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const accountName = match[1];
    const accounts = loadAccounts();
    
    const index = accounts.findIndex(a => a.ten.toLowerCase() === accountName.toLowerCase());
    if (index === -1) {
        bot.sendMessage(chatId, '❌ Không tìm thấy tài khoản này!');
        return;
    }

    const deleted = accounts.splice(index, 1)[0];
    saveAccounts(accounts);
    bot.sendMessage(chatId, `✅ Đã xóa tài khoản "${deleted.ten}" với số dư ${formatCurrency(deleted.sodu)}`);
});

// Command to update account balance
bot.onText(/\/capnhattk (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const input = match[1].split(' ');
    
    if (input.length < 2) {
        bot.sendMessage(chatId, '❌ Vui lòng nhập theo định dạng: /capnhattk [tên tài khoản] [số dư mới]\nVí dụ: /capnhattk Ví 150k');
        return;
    }

    const newBalance = parseMoneyString(input[input.length - 1]);
    if (newBalance === null) {
        bot.sendMessage(chatId, '❌ Số dư không hợp lệ. Vui lòng sử dụng định dạng: 100k, 1m, ...');
        return;
    }

    const accountName = input.slice(0, -1).join(' ');
    const accounts = loadAccounts();
    
    const account = accounts.find(a => a.ten.toLowerCase() === accountName.toLowerCase());
    if (!account) {
        bot.sendMessage(chatId, '❌ Không tìm thấy tài khoản này!');
        return;
    }

    const oldBalance = account.sodu;
    account.sodu = newBalance;
    saveAccounts(accounts);
    
    bot.sendMessage(chatId, 
        `✅ Đã cập nhật số dư tài khoản "${account.ten}":\n` +
        `Số dư cũ: ${formatCurrency(oldBalance)}\n` +
        `Số dư mới: ${formatCurrency(newBalance)}`
    );
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

// Command to search transactions
bot.onText(/\/timkiem (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const keyword = match[1].toLowerCase();
    const transactions = loadTransactions();

    const filtered = transactions.filter(t => 
        t.ghichu.toLowerCase().includes(keyword) || 
        t.taikhoan.toLowerCase().includes(keyword)
    );

    if (filtered.length === 0) {
        bot.sendMessage(chatId, '❌ Không tìm thấy giao dịch nào.');
        return;
    }

    let message = `🔍 KẾT QUẢ TÌM KIẾM (${filtered.length} giao dịch)\n\n`;
    filtered.forEach((t, i) => {
        const date = new Date(t.ngay).toLocaleDateString('vi-VN');
        const type = t.loai === 'thu' ? '💰 Thu' : '💸 Chi';
        message += `${i + 1}. ${type}: ${formatCurrency(t.sotien)}\n📝 ${t.ghichu}\n💳 ${t.taikhoan}\n📅 ${date}\n\n`;
    });

    bot.sendMessage(chatId, message);
});

// Command to filter transactions by date range
bot.onText(/\/loc (.+)/, (msg, match) => {
    const chatId = msg.chat.id;
    const params = match[1].split(' ');
    
    if (params.length !== 2) {
        bot.sendMessage(chatId, 
            '❌ Vui lòng nhập theo định dạng: /loc [số ngày] [loại]\n' +
            'Loại: thu, chi, all\n' +
            'Ví dụ:\n' +
            '/loc 7 all (xem tất cả giao dịch 7 ngày qua)\n' +
            '/loc 30 thu (xem khoản thu 30 ngày qua)\n' +
            '/loc 90 chi (xem khoản chi 90 ngày qua)'
        );
        return;
    }

    const days = parseInt(params[0]);
    const type = params[1].toLowerCase();
    
    if (isNaN(days) || days <= 0) {
        bot.sendMessage(chatId, '❌ Số ngày không hợp lệ.');
        return;
    }

    if (!['thu', 'chi', 'all'].includes(type)) {
        bot.sendMessage(chatId, '❌ Loại giao dịch không hợp lệ. Vui lòng chọn: thu, chi, hoặc all');
        return;
    }

    const transactions = loadTransactions();
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - days);

    const filtered = transactions.filter(t => {
        const transDate = new Date(t.ngay);
        return transDate >= cutoffDate && 
               (type === 'all' || 
                (type === 'thu' && t.loai === 'thu') || 
                (type === 'chi' && t.loai === 'chi'));
    });

    if (filtered.length === 0) {
        bot.sendMessage(chatId, '❌ Không có giao dịch nào trong khoảng thời gian này.');
        return;
    }

    // Calculate totals
    const totalIncome = filtered
        .filter(t => t.loai === 'thu')
        .reduce((sum, t) => sum + t.sotien, 0);
    const totalExpense = filtered
        .filter(t => t.loai === 'chi')
        .reduce((sum, t) => sum + t.sotien, 0);

    let message = `📊 GIAO DỊCH ${days} NGÀY QUA\n\n`;
    
    // Add summary
    message += `💰 Tổng thu: ${formatCurrency(totalIncome)}\n`;
    message += `💸 Tổng chi: ${formatCurrency(totalExpense)}\n`;
    message += `💎 Còn lại: ${formatCurrency(totalIncome - totalExpense)}\n\n`;
    
    // Group by account
    const accountStats = {};
    filtered.forEach(t => {
        if (!accountStats[t.taikhoan]) {
            accountStats[t.taikhoan] = { thu: 0, chi: 0 };
        }
        if (t.loai === 'thu') {
            accountStats[t.taikhoan].thu += t.sotien;
        } else {
            accountStats[t.taikhoan].chi += t.sotien;
        }
    });

    // Add account summary
    message += `📊 THEO TÀI KHOẢN:\n`;
    Object.entries(accountStats).forEach(([account, stats]) => {
        message += `\n💳 ${account}:\n`;
        message += `  💰 Thu: ${formatCurrency(stats.thu)}\n`;
        message += `  💸 Chi: ${formatCurrency(stats.chi)}\n`;
        message += `  💎 Còn: ${formatCurrency(stats.thu - stats.chi)}\n`;
    });

    message += `\n📝 CHI TIẾT GIAO DỊCH:\n`;
    filtered.forEach((t, i) => {
        const date = new Date(t.ngay).toLocaleDateString('vi-VN');
        const type = t.loai === 'thu' ? '💰 Thu' : '💸 Chi';
        message += `\n${i + 1}. ${type}: ${formatCurrency(t.sotien)}\n📝 ${t.ghichu}\n💳 ${t.taikhoan}\n📅 ${date}`;
    });

    bot.sendMessage(chatId, message);
});

// Command to add reminder
bot.onText(/\/nhacnho/, (msg) => {
    const chatId = msg.chat.id;
    
    const options = {
        reply_markup: {
            inline_keyboard: [
                [{ text: '➕ Thêm nhắc nhở mới', callback_data: 'add_reminder' }],
                [{ text: '📋 Xem danh sách nhắc nhở', callback_data: 'list_reminders' }],
                [{ text: '❌ Xóa nhắc nhở', callback_data: 'delete_reminder' }]
            ]
        }
    };
    
    bot.sendMessage(chatId, '⏰ QUẢN LÝ NHẮC NHỞ THANH TOÁN\n\nChọn thao tác:', options);
});

// Handle reminder setup flow
const reminderSetupStates = new Map();

bot.on('callback_query', async (callbackQuery) => {
    const chatId = callbackQuery.message.chat.id;
    const messageId = callbackQuery.message.message_id;
    const data = callbackQuery.data;

    if (data === 'add_reminder') {
        reminderSetupStates.set(chatId, { step: 1 });
        const periods = [
            [{ text: 'Hàng tháng', callback_data: 'period_monthly' }],
            [{ text: 'Hàng quý', callback_data: 'period_quarterly' }],
            [{ text: 'Hàng năm', callback_data: 'period_yearly' }]
        ];
        
        await bot.editMessageText('Chọn chu kỳ nhắc nhở:', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: periods }
        });
    }
    else if (data.startsWith('period_')) {
        const state = reminderSetupStates.get(chatId) || {};
        state.period = data.replace('period_', '');
        state.step = 2;
        reminderSetupStates.set(chatId, state);
        
        await bot.editMessageText(
            'Nhập số tiền và ghi chú (VD: 100k tiền điện):', 
            {
                chat_id: chatId,
                message_id: messageId
            }
        );
    }
    else if (data === 'list_reminders') {
        const reminders = loadReminders();
        if (reminders.length === 0) {
            await bot.editMessageText('❌ Chưa có nhắc nhở nào.', {
                chat_id: chatId,
                message_id: messageId
            });
            return;
        }

        let message = '📋 DANH SÁCH NHẮC NHỞ\n\n';
        reminders.forEach((r, i) => {
            message += `${i + 1}. ${r.note}\n`;
            message += `💰 Số tiền: ${formatCurrency(r.amount)}\n`;
            message += `🔄 Định kỳ: ${r.period}\n\n`;
        });

        await bot.editMessageText(message, {
            chat_id: chatId,
            message_id: messageId
        });
    }
    else if (data === 'delete_reminder') {
        const reminders = loadReminders();
        if (reminders.length === 0) {
            await bot.editMessageText('❌ Chưa có nhắc nhở nào để xóa.', {
                chat_id: chatId,
                message_id: messageId
            });
            return;
        }

        const keyboard = reminders.map((r, i) => [{
            text: `${i + 1}. ${r.note} (${formatCurrency(r.amount)})`,
            callback_data: `delete_reminder_${i}`
        }]);

        await bot.editMessageText('Chọn nhắc nhở cần xóa:', {
            chat_id: chatId,
            message_id: messageId,
            reply_markup: { inline_keyboard: keyboard }
        });
    }
    else if (data.startsWith('delete_reminder_')) {
        const index = parseInt(data.split('_')[2]);
        const reminders = loadReminders();
        const deleted = reminders.splice(index, 1)[0];
        saveReminders(reminders);
        
        // Cancel the scheduled job
        const job = schedule.scheduledJobs[deleted.id];
        if (job) {
            job.cancel();
        }

        await bot.editMessageText(`✅ Đã xóa nhắc nhở: ${deleted.note}`, {
            chat_id: chatId,
            message_id: messageId
        });
    }

    await bot.answerCallbackQuery(callbackQuery.id);
});

// Handle reminder amount and note input
bot.on('message', (msg) => {
    const chatId = msg.chat.id;
    const state = reminderSetupStates.get(chatId);
    
    if (state && state.step === 2) {
        const text = msg.text.trim();
        const parts = text.split(/\s+/);
        const amountStr = parts[0];
        const note = parts.slice(1).join(' ');

        const amount = parseMoneyString(amountStr);
        if (!amount) {
            bot.sendMessage(chatId, '❌ Số tiền không hợp lệ. Vui lòng thử lại (VD: 100k tiền điện)');
            return;
        }

        if (!note) {
            bot.sendMessage(chatId, '❌ Vui lòng nhập ghi chú cho nhắc nhở');
            return;
        }

        // Create reminder object
        const reminder = {
            id: `reminder_${Date.now()}`,
            amount,
            note,
            period: state.period,
            chatId,
            cron: getCronExpression(state.period)
        };

        // Save reminder
        const reminders = loadReminders();
        reminders.push(reminder);
        saveReminders(reminders);

        // Schedule the reminder
        scheduleReminder(reminder);

        // Clear setup state
        reminderSetupStates.delete(chatId);

        bot.sendMessage(
            chatId,
            `✅ Đã tạo nhắc nhở:\n\n` +
            `📝 Ghi chú: ${reminder.note}\n` +
            `💰 Số tiền: ${formatCurrency(reminder.amount)}\n` +
            `🔄 Định kỳ: ${reminder.period}`
        );
    }
});

// Helper function to get cron expression
function getCronExpression(period) {
    const now = new Date();
    switch (period) {
        case 'monthly':
            return `0 9 ${now.getDate()} * *`; // Same day every month at 9 AM
        case 'quarterly':
            return `0 9 ${now.getDate()} */3 *`; // Every 3 months
        case 'yearly':
            return `0 9 ${now.getDate()} ${now.getMonth() + 1} *`; // Same date every year
        default:
            return '0 9 1 * *'; // First day of every month at 9 AM
    }
}

// Schedule all reminders
function scheduleAllReminders() {
    const reminders = loadReminders();
    reminders.forEach(reminder => {
        scheduleReminder(reminder);
    });
}

// Schedule a single reminder
function scheduleReminder(reminder) {
    const job = schedule.scheduleJob(reminder.id, reminder.cron, () => {
        bot.sendMessage(reminder.chatId, 
            `⏰ NHẮC NHỞ THANH TOÁN!\n\n` +
            `💰 Khoản: ${reminder.note}\n` +
            `💵 Số tiền: ${formatCurrency(reminder.amount)}\n` +
            `🔄 Định kỳ: ${reminder.period}`
        );
    });
    return job;
}

// Command to export Excel report
bot.onText(/\/xuatexcel/, async (msg) => {
    const chatId = msg.chat.id;
    const transactions = loadTransactions();
    
    if (transactions.length === 0) {
        bot.sendMessage(chatId, '❌ Chưa có giao dịch nào để xuất báo cáo.');
        return;
    }

    const fileName = `BaoCaoThuChi_${new Date().toISOString().split('T')[0]}.xlsx`;
    const filePath = `./${fileName}`;

    try {
        const workbook = new ExcelJS.Workbook();
        const worksheet = workbook.addWorksheet('Giao dịch');

        // Add headers
        worksheet.columns = [
            { header: 'Ngày', key: 'date', width: 15 },
            { header: 'Loại', key: 'type', width: 10 },
            { header: 'Số tiền', key: 'amount', width: 15 },
            { header: 'Ghi chú', key: 'note', width: 30 },
            { header: 'Tài khoản', key: 'account', width: 15 }
        ];

        // Style headers
        worksheet.getRow(1).font = { bold: true };
        worksheet.getRow(1).fill = {
            type: 'pattern',
            pattern: 'solid',
            fgColor: { argb: 'FFE0E0E0' }
        };

        // Add data
        transactions.forEach(t => {
            worksheet.addRow({
                date: new Date(t.ngay).toLocaleDateString('vi-VN'),
                type: t.loai === 'thu' ? 'Thu' : 'Chi',
                amount: t.sotien,
                note: t.ghichu,
                account: t.taikhoan
            });
        });

        // Format amount column
        worksheet.getColumn('amount').numFmt = '#,##0';
        
        // Add summary
        const totalIncome = transactions
            .filter(t => t.loai === 'thu')
            .reduce((sum, t) => sum + t.sotien, 0);
        const totalExpense = transactions
            .filter(t => t.loai === 'chi')
            .reduce((sum, t) => sum + t.sotien, 0);

        const summaryStartRow = worksheet.rowCount + 2;
        
        worksheet.addRow([]);
        const totalIncomeRow = worksheet.addRow(['Tổng thu', '', totalIncome]);
        const totalExpenseRow = worksheet.addRow(['Tổng chi', '', totalExpense]);
        const balanceRow = worksheet.addRow(['Số dư', '', totalIncome - totalExpense]);

        // Style summary rows
        [totalIncomeRow, totalExpenseRow, balanceRow].forEach(row => {
            if (row && row.getCell) {
                row.font = { bold: true };
                const amountCell = row.getCell(3);
                if (amountCell) {
                    amountCell.numFmt = '#,##0';
                }
            }
        });

        // Save file
        await workbook.xlsx.writeFile(filePath);

        // Send file using fs.createReadStream
        await bot.sendDocument(chatId, fs.createReadStream(filePath), {
            caption: '📊 BÁO CÁO THU CHI\n' +
                    `💰 Tổng thu: ${formatCurrency(totalIncome)}\n` +
                    `💸 Tổng chi: ${formatCurrency(totalExpense)}\n` +
                    `💎 Số dư: ${formatCurrency(totalIncome - totalExpense)}`
        });

        // Delete file after sending
        fs.unlinkSync(filePath);

    } catch (error) {
        console.error('Error exporting Excel:', error);
        bot.sendMessage(chatId, '❌ Có lỗi xảy ra khi xuất báo cáo Excel. Chi tiết lỗi: ' + error.message);
        
        // Clean up file if it exists
        if (fs.existsSync(filePath)) {
            fs.unlinkSync(filePath);
        }
    }
});

// Initialize reminders when bot starts
scheduleAllReminders();

// Error handling
bot.on('polling_error', (error) => {
    if (error.response && error.response.statusCode === 401) {
        console.error('Telegram token is invalid');
        process.exit(1);
    }
    console.error('Polling error:', error);
});
