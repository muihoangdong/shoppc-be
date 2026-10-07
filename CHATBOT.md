# Chatbot AI quản lý dashboard

Chatbot nằm ở góc phải dưới của trang admin. Người dùng chat bằng tiếng Việt; AI (mặc định Google Gemini) gọi các "tool" ở backend để tra cứu / thao tác, thay vì tự bịa số liệu.

## Cài đặt (Google Gemini)

1. Cần Node.js **>= 18** (backend dùng `fetch` có sẵn, không cần cài thêm package nào).
2. Lấy key miễn phí: vào https://aistudio.google.com → **Get API key** → **Create API key**.
3. Thêm vào `shoppc-be/.env` (xem mẫu ở `.env.example`), mỗi biến **một dòng**:
   ```
   AI_PROVIDER=gemini
   GEMINI_API_KEY=AIza...
   # AI_MODEL=gemini-3.5-flash     # tùy chọn; để trống = mặc định
   ```
4. Chạy `npm run ai:check` để kiểm tra key, mạng và bộ công cụ; rồi chạy lại backend. Dòng log `🤖 AI: Google Gemini · ...` cho biết đã nhận cấu hình.
5. Frontend admin/storefront không cần cấu hình thêm (dùng chung `VITE_API_URL`). **Không** đặt API key ở frontend.

Chi tiết kỹ thuật:
- Backend gọi **API gốc** của Gemini (`models/{model}:generateContent`, key gửi qua header `x-goog-api-key`), không qua endpoint kiểu OpenAI. Nhờ vậy giữ được `thoughtSignature` mà Gemini 3.x bắt buộc gửi lại khi chatbot gọi công cụ nhiều bước (thiếu nó Google báo lỗi 400).
- Model mặc định `gemini-3.5-flash`. Nếu model đó không dùng được với key (404) **hoặc đang quá tải / hết lượt (503, 429)**, server tự thử `gemini-3-flash-preview` → `gemini-3.5-flash-lite` → `gemini-flash-latest` → `gemini-3.1-flash-lite`. Model không tồn tại thì nhớ model chạy được; quá tải chỉ là tạm thời nên lần sau vẫn thử model chính trước. Tự đặt `AI_MODEL` thì không tự đổi.
- Các model `gemini-2.5-*` bị Google tắt từ **16/10/2026**: nếu `.env` đang có `AI_MODEL=gemini-2.5-flash`, hãy xóa dòng đó.
- "Suy nghĩ": đời 3.x dùng mức `LOW` (đổi bằng `AI_THINKING_LEVEL=minimal|low|medium|high`), đời 2.5 Flash tắt hẳn. Model không nhận tham số này thì server tự gửi lại không kèm.
- Google quá tải tạm thời (500/503) thì tự thử lại một lần; lời gọi công cụ bị Gemini sinh hỏng (`MALFORMED_FUNCTION_CALL`) cũng thử lại một lần.
- Không đặt `AI_PROVIDER` mà chỉ có `GEMINI_API_KEY` (không có `ANTHROPIC_API_KEY`) thì server tự dùng Gemini.
- Kiểm thử (không cần DB, mạng, key): `npm run test:gemini`.

## Chatbot làm được gì

| Trang dashboard | Tra cứu (chạy ngay) | Thay đổi (cần bấm Xác nhận) |
|---|---|---|
| Tổng quan | `get_dashboard_stats` | – |
| Thống kê | `get_analytics` (hôm nay / 7 ngày / tháng này / tháng trước / năm / khoảng tùy chọn) | – |
| Sản phẩm | `list_products`, `get_product` | `create_product`, `update_product`, `update_stock`, `delete_product` (admin) |
| Danh mục | `list_categories` | `create_category`, `update_category`, `delete_category` (admin) |
| Đơn hàng | `list_orders`, `get_order` | `update_order_status` |
| Cài đặt | – | `update_my_profile` |
| Điều hướng | `navigate` (mở trang bất kỳ) | – |

Ví dụ: "Sản phẩm nào sắp hết hàng?", "Nhập thêm 20 cái RAM Corsair 32GB", "Giảm 10% giá toàn bộ danh mục Laptop", "Doanh thu tháng trước?", "Chuyển đơn ORD-171... sang đang giao", "Mở trang đơn hàng".

## An toàn

- **Mọi thao tác ghi dữ liệu đều phải được người dùng bấm Xác nhận.** Server không chạy tool ghi ngay mà trả về thẻ xác nhận; nội dung thẻ do server tự sinh từ dữ liệu thật (giá cũ → mới, tên sản phẩm...), không phải do AI viết. Thao tác dùng một lần, chỉ chủ phiên xác nhận được, tự hết hạn sau 10 phút.
- Chỉ tài khoản `admin`/`staff` đã đăng nhập dùng được `/api/chat`. Quyền được kiểm tra lại ở server mỗi lần; **xóa sản phẩm/danh mục chỉ dành cho admin** (đổi `access: 'admin'` thành `'staff'` trong `src/services/ai/tools.js` nếu muốn nới).
- Đầu vào của mọi tool được kiểm tra (kiểu, khoảng giá trị, danh sách trạng thái hợp lệ...) và truy vấn đều dùng tham số hóa. Giá phải là số nguyên VND.
- AI không đổi được mật khẩu và không bao giờ nhận mật khẩu qua chat.
- Giới hạn: 20 tin/phút/người (`AI_RATE_LIMIT_PER_MIN`), 20 thao tác ghi mỗi lượt, 6 vòng tool mỗi lượt.
- Nhật ký: mỗi thao tác đã thực hiện được ghi ra console (`[chatbot] <user> executed <tool> ...`).

## Lưu ý

- Khi hỏi về đơn hàng, thông tin khách (tên, SĐT, địa chỉ) được gửi tới dịch vụ AI để trả lời. Cân nhắc điều này theo chính sách dữ liệu của cửa hàng.
- Đơn hàng đổi trạng thái theo đúng vòng đời (xem `src/config/orderStatus.js`); hủy đơn qua chatbot **tự hoàn lại tồn kho**, giống nút Hủy trên trang Đơn hàng.
- Các thao tác chờ xác nhận lưu trong bộ nhớ tiến trình (`pendingStore.js`). Nếu chạy nhiều instance backend, hãy chuyển sang Redis/MySQL (giao diện `add/take/discard` giữ nguyên).
- Kiểm thử logic (không cần DB, mạng, key): `npm run test:chatbot`.

## Realtime, chat hỗ trợ khách hàng và các tính năng AI khác

### Realtime (Server-Sent Events)
- Dashboard nhận ngay: đơn mới (toast + âm báo, có nút tắt âm), đơn đổi trạng thái, tồn kho/sản phẩm đổi, tin nhắn khách. Các trang tự làm mới, không cần F5.
- Kết nối bằng "vé" dùng một lần (60 giây) xin qua `POST /api/realtime/ticket`, rồi mở `GET /api/realtime/stream?ticket=...`. Mất kết nối thì tự kết nối lại với vé mới và tải lại phần đã lỡ.
- Góc trên dashboard hiện trạng thái: "Trực tiếp" / "Đang kết nối lại…".

### Chat hỗ trợ khách hàng
- Khách: nút chat ở góc phải mọi trang của cửa hàng; không cần đăng nhập (token ẩn danh được ký số), khách đã đăng nhập thì hội thoại gắn với tài khoản.
- Nhân viên: trang **Hỗ trợ** trong dashboard (`/admin/support`) — danh sách hội thoại, chưa đọc, đang gõ, đã xem, trả lời nhanh, kết thúc/mở lại, nhận hội thoại.
- **Trợ lý AI cho khách** (khi đã cấu hình AI, ví dụ `GEMINI_API_KEY`): chỉ được ĐỌC thông tin công khai (sản phẩm, danh mục) và tra đơn khi khách đưa đúng cả mã đơn lẫn số điện thoại. Có nhân viên trực tuyến thì AI chờ `SUPPORT_AI_DELAY_MS` để nhân viên trả lời trước; nhân viên trả lời là AI tự tắt cho hội thoại đó. Khách bấm "Gặp nhân viên" hoặc AI không chắc chắn thì chuyển cho nhân viên. Tối đa `SUPPORT_AI_MAX_PER_HOUR` tin AI/giờ/hội thoại.
- Cần các bảng `support_conversations`, `support_messages`: chạy `npm run migrate-db -- --apply` (xem `DATABASE.md`).

### Nút AI trên dashboard
- **Gợi ý trả lời** (trang Hỗ trợ): AI soạn sẵn câu trả lời vào ô soạn tin — nhân viên đọc, sửa rồi mới gửi.
- **Viết mô tả bằng AI** (form sản phẩm): từ tên + danh mục + thông số; có nút Hoàn tác.
- **Phân tích nhanh bằng AI** (Tổng quan): nhận xét số liệu 7/30 ngày kèm việc nên làm; chỉ gọi khi bấm (tránh tốn tiền).
- Chưa cấu hình API key thì mọi nút AI tự ẩn.

### Chatbot quản trị (nâng cấp)
- Biết bạn đang xem trang nào (ví dụ đang mở chi tiết đơn #25) nên hiểu "đơn này", "hội thoại này"; gợi ý câu hỏi thay đổi theo trang.
- Thêm công cụ: xem danh sách / đọc hội thoại hỗ trợ, gửi tin cho khách (cần bấm Xác nhận như mọi thao tác ghi).
- Hội thoại với chatbot được giữ khi tải lại trang (thẻ xác nhận cũ không được lưu nên không thể thực thi lại).

## Chọn nhà cung cấp AI (Gemini, Claude, Ollama)
Đặt `AI_PROVIDER` trong `shoppc-be/.env`, rồi khởi động lại backend. Dòng log `🤖 AI:` cho biết đang dùng gì. Mọi tính năng (chatbot admin, trợ lý khách, các nút AI) hoạt động giống nhau với cả ba lựa chọn.

| Lựa chọn | Cấu hình | Ghi chú |
|---|---|---|
| **Gemini** (khuyên dùng) | `AI_PROVIDER=gemini`, `GEMINI_API_KEY=...` | Có gói miễn phí (giới hạn lượt/phút, lượt/ngày). Lấy key: aistudio.google.com → Get API key. Model mặc định `gemini-3.5-flash`, tự chọn model dự phòng nếu không có |
| Gemini (cách cũ) | `AI_PROVIDER=gemini-openai`, `GEMINI_API_KEY=...` | Qua endpoint kiểu OpenAI của Google; chỉ giữ để tương thích, Gemini 3.x có thể lỗi khi gọi công cụ nhiều bước |
| Claude | `AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY=...` | Trả phí. Rẻ/nhanh: `AI_MODEL=claude-haiku-4-5-20251001` |
| **Ollama** | `AI_PROVIDER=ollama` | Miễn phí, chạy trên máy, dữ liệu không rời máy. Cài từ ollama.com, rồi `ollama pull qwen2.5:7b`. Máy yếu: `qwen2.5:3b` (kém chính xác hơn); máy mạnh: `qwen2.5:14b` |
| Dịch vụ khác kiểu OpenAI | `AI_PROVIDER=openai-compatible`, `AI_BASE_URL`, `AI_API_KEY`, `AI_MODEL` | Ví dụ Groq, OpenRouter |

Lưu ý:
- Gói miễn phí của Gemini: dữ liệu gửi lên (gồm tin nhắn, tên/SĐT khách, thông tin đơn) có thể được Google dùng để cải thiện sản phẩm — đọc điều khoản trước khi dùng cho cửa hàng thật. Hết lượt miễn phí thì trợ lý khách tự chuyển cho nhân viên.
- Model nhỏ (Ollama) kém chính xác hơn khi gọi công cụ; mọi thao tác ghi vẫn phải bấm Xác nhận nên không tự ý sửa dữ liệu.
- Ollama chạy trên máy của bạn: backend deploy lên Render sẽ không gọi được Ollama ở máy nhà. Dùng Ollama khi chạy local, hoặc trên một server có Ollama.

## Lỗi "Không kết nối được với chatbot AI"
Chạy **`npm run ai:check`** trong `shoppc-be`: lệnh kiểm tra lần lượt Node, cấu hình, DNS, một lời gọi mô hình thật, và một lời gọi kèm đúng bộ công cụ của chatbot, rồi nói rõ bước nào hỏng. Không in API key. Thông báo lỗi trong khung chat bây giờ cũng nêu nguyên nhân thật kèm mã lỗi.

| Thông báo / mã lỗi | Nguyên nhân thường gặp | Cách sửa |
|---|---|---|
| "Không kết nối được tới máy chủ backend" (trong khung chat) | Backend chưa chạy hoặc sai địa chỉ | Chạy backend; kiểm tra `VITE_API_URL` của admin |
| `ENOTFOUND`, `EAI_AGAIN` | Lỗi DNS / không có Internet | Kiểm tra mạng, đổi DNS sang 8.8.8.8; bật VPN nếu mạng chặn Google |
| `ETIMEDOUT`, `UND_ERR_CONNECT_TIMEOUT`, `ENETUNREACH` | Tường lửa/mạng chặn, hoặc IPv6 hỏng | Bật VPN; hoặc dùng proxy (`AI_PROXY_URL` + `npm install undici`). Server đã mặc định ưu tiên IPv4 |
| `UNABLE_TO_VERIFY_LEAF_SIGNATURE`, `SELF_SIGNED_CERT_IN_CHAIN` | Phần mềm diệt virus/proxy công ty chèn chứng chỉ | Đặt `NODE_EXTRA_CA_CERTS` trỏ tới file chứng chỉ gốc của nó. Không tắt kiểm tra chứng chỉ |
| "Google từ chối GEMINI_API_KEY" | Key sai/đã xóa; `.env` có **hai dòng** `GEMINI_API_KEY` | Mỗi khóa chỉ một dòng; tạo key mới ở aistudio.google.com |
| "Nhà cung cấp từ chối phần khai báo công cụ" | Model không nhận khai báo công cụ | Đổi `AI_MODEL`; gửi nguyên văn thông báo để được hỗ trợ |
| Trả lời rỗng / bị cắt | Model dùng hết token để "suy nghĩ" | `AI_THINKING_LEVEL=minimal` hoặc tăng `AI_MAX_TOKENS` (cách cũ `gemini-openai`: `AI_REASONING_EFFORT=none`) |
| "Model Gemini ... không tồn tại hoặc đã bị Google ngừng" | `AI_MODEL` trỏ tới model cũ (ví dụ `gemini-2.5-flash` sau 16/10/2026) | Xóa dòng `AI_MODEL` để dùng mặc định |
| "Google chưa hỗ trợ Gemini API ở khu vực của máy chủ" | Máy chủ ở vùng gói miễn phí không dùng được | Bật thanh toán cho project Google, hoặc đổi vùng máy chủ |

Lưu ý bảo mật: API key chỉ đặt trong `.env` (đã được `.gitignore`), **không** đặt trong `.env.example` vì file đó được chia sẻ/commit.
