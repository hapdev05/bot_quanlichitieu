# Quản Lý Thu Chi Bot

Bot Telegram để quản lý thu chi cá nhân với phân tích thông minh từ Gemini AI.

## Cài đặt

1. Clone repository
2. Cài đặt dependencies:
```bash
npm install
```
3. Tạo file `.env` với nội dung:
```
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
GEMINI_API_KEY=your_gemini_api_key
```
4. Chạy bot:
```bash
npm start
```

## Sử dụng

### Ghi chép giao dịch
- Ghi chi: `10k cafe` hoặc `-10k cafe`
- Ghi thu: `+10k luong`

### Các lệnh
- `/start` - Xem hướng dẫn sử dụng
- `/xem` - Xem sổ thu chi
- `/thongke` - Xem báo cáo tổng quan
- `/phanTich` - Phân tích dữ liệu tài chính

### Định dạng số tiền
- `k` = nghìn (10k = 10,000đ)
- `m` = triệu (1m = 1,000,000đ)
