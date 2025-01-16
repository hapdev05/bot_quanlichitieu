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

    const totalIncome = transactions
        .filter(t => t.loai === 'thu')
        .reduce((sum, t) => sum + t.sotien, 0);

    const totalExpense = transactions
        .filter(t => t.loai === 'chi')
        .reduce((sum, t) => sum + t.sotien, 0);

    const message = `📊 BÁO CÁO THU CHI\n\n` +
        `💰 Tổng thu: ${formatCurrency(totalIncome)}\n` +
        `💸 Tổng chi: ${formatCurrency(totalExpense)}\n` +
        `💎 Số dư: ${formatCurrency(totalIncome - totalExpense)}`;

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

// Error handling
bot.on('polling_error', (error) => {
    if (error.response && error.response.statusCode === 401) {
        console.error('Telegram token is invalid');
        process.exit(1);
    }
    console.error('Polling error:', error);
});
