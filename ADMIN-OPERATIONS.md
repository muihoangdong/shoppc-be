# Nghiệp vụ admin linh kiện

Các màn hình được thêm vào admin hiện tại, sử dụng API `/api/operations`.

| Mục | Đường dẫn admin | Nghiệp vụ |
| --- | --- | --- |
| Nhà cung cấp | `/admin/suppliers` | Mã, liên hệ, địa chỉ, mã số thuế, trạng thái hợp tác |
| Nhập kho | `/admin/purchases` | Phiếu nháp nhiều sản phẩm, giá nhập, serial, xác nhận hoặc hủy nháp |
| Lịch sử kho | `/admin/inventory` | Tồn trước/sau, lượng thay đổi, nguồn, lý do, người thao tác; điều chỉnh kiểm kê |
| Serial và bảo hành | `/admin/warranty` | Đăng ký, gán đơn, thu hồi, hạn bảo hành và phiếu xử lý lỗi |
| Vận chuyển | `/admin/shipping` | Hãng, mã vận đơn, dự kiến giao, lịch sử và đồng bộ trạng thái đơn |
| Đổi trả và hoàn tiền | `/admin/returns` | Yêu cầu theo dòng hàng, duyệt, tiếp nhận, nhập lại kho và ghi nhận hoàn tiền |
| Thương hiệu và thông số | `/admin/catalog-standards` | Hãng, mẫu thông số theo danh mục; trường bắt buộc, số, văn bản, danh sách chọn |
| Nhập/xuất hàng loạt | `/admin/bulk` | CSV UTF-8, file mẫu, kiểm tra từng dòng, xem trước và xác nhận nhập |
| Nhật ký | `/admin/audit` | Nhật ký chỉ đọc, tìm kiếm, lọc ngày và chi tiết thay đổi |

## Cài đặt

Chạy trong backend:

```sh
npm run migrate-db
npm run migrate-db -- --apply
npm start
```

Migration thêm 10 bảng, các cột SKU/hãng/mẫu thông số/bảo hành/serial của sản phẩm và các chỉ mục/khóa ngoại liên quan. Không xóa dữ liệu hay đổi các bảng không liên quan. Cần khởi động lại backend sau migration. Admin dùng `VITE_API_URL` hiện có.

## Quyền

- Admin quản lý hãng, mẫu thông số, nhà cung cấp; xác nhận nhập kho, điều chỉnh tồn và thu hồi serial; duyệt/từ chối/ghi hoàn tiền; nhập/xuất CSV và xem audit.
- Staff xem dữ liệu, lập/sửa/hủy phiếu nhập nháp, đăng ký/gán serial, xử lý bảo hành, vận chuyển, tạo và tiếp nhận đổi trả. Quyền được kiểm tra lại tại API.
- Customer không được gọi API nghiệp vụ admin.

## Quy trình

1. Tạo hãng, mẫu thông số theo danh mục và nhà cung cấp.
2. Trong sản phẩm, nhập SKU, hãng, thời hạn bảo hành; chọn mẫu thông số và chế độ serial nếu cần. Sản phẩm mới theo serial bắt đầu với tồn 0.
3. Lập phiếu nhập. Mỗi sản phẩm có một dòng; nếu theo serial, số serial phải bằng số lượng. Xác nhận nhập cộng tồn, đăng ký serial và ghi lịch sử trong cùng giao dịch. Phiếu đã nhập không sửa hay nhập lại được.
4. Đặt hàng giữ/trừ tồn theo luồng cũ. Gán đủ serial vào từng dòng đơn trước khi chuyển sang đang giao. Hủy đơn hoàn tồn và trả serial đã gán về kho.
5. Tạo vận đơn cho đơn đang xử lý. Bàn giao chuyển đơn sang đang giao; giao thành công chuyển đơn sang đã giao và ghi đã thanh toán cho COD. Đổi trạng thái ở trang đơn hàng cũng đồng bộ vận đơn đang hoạt động.
6. Tiếp nhận bảo hành cho serial đã bán thuộc đơn đã giao/hoàn tất. Chuyển tiếp nhận → kiểm tra → sửa chữa → xử lý/từ chối; kết thúc cần ghi kết quả. Hạn bảo hành bắt đầu khi gán serial vào đơn, theo số tháng của sản phẩm.
7. Tạo đổi trả cho từng dòng hàng của đơn đã giao/hoàn tất. Duyệt số tiền, nhận hàng và quyết định nhập lại kho; hàng theo serial phải chọn đúng serial. Hoàn tiền chỉ ghi nhận sau khi đã nhận hàng, đơn đã thanh toán và có mã tham chiếu giao dịch. Phiếu không hoàn tiền có thể kết thúc sau tiếp nhận. Không cộng kho hoặc ghi hoàn tiền hai lần.

## CSV

- UTF-8, tối đa 2 MB / 500 sản phẩm nhập; tối đa 10.000 sản phẩm xuất.
- Cột bắt buộc: `sku,name,category_id,price,stock`. Các cột khác xem file mẫu hoặc bản xuất.
- Có `id`: cập nhật theo ID. Không có ID: tìm theo SKU; chưa có thì tạo mới.
- Các cột nhập thay thế dữ liệu tương ứng; các giá trị mặc định gồm bảo hành 12 tháng, không bắt buộc serial, không gán hãng/mẫu nếu thiếu. Nên xuất trước, sửa bản xuất rồi nhập lại để giữ đầy đủ thông tin.
- `specs` là JSON object, `image_urls` là JSON array; không thay thế mô hình 3D bằng CSV.
- Hàng đã có serial hoặc bật theo dõi serial không đổi tồn trực tiếp bằng CSV/form sản phẩm/AI. Dùng phiếu nhập, xử lý đổi trả hoặc thu hồi serial.
- Bắt buộc xem trước và nhập lý do. Nếu dữ liệu đã thay đổi sau lần xem trước, phải xem trước lại. Áp dụng nguyên giao dịch; một dòng lỗi sẽ rollback tất cả.

## Phạm vi hiện tại

- Vận chuyển được quản lý thủ công; chưa gọi API GHN/GHTK/Viettel Post hoặc mua nhãn vận chuyển.
- Hoàn tiền là ghi nhận giao dịch đã thực hiện bên ngoài; không tự chuyển tiền qua ngân hàng/cổng thanh toán. Giới hạn hoàn theo giá hàng sau phân bổ giảm giá, không gồm phí vận chuyển. Báo cáo doanh thu cũ chưa khấu trừ hoàn tiền từng phần.
- Đổi sang sản phẩm khác thực hiện bằng phiếu trả hàng và đơn bán mới; chưa có phiếu đổi bù chênh lệch riêng.
- Lịch sử kho và nhật ký bắt đầu từ khi tính năng hoạt động, không dựng lại lịch sử cũ. Tồn của hệ thống vẫn là một kho.
- Audit nghiệp vụ mới được ghi trong giao dịch; các thao tác admin cũ ghi HTTP thành công, sản phẩm có chi tiết trước/sau. Không lưu body đăng nhập, token hay nội dung chat. Audit HTTP cũ là ghi nền nên lỗi ghi được báo ở log server.
- Danh sách lựa chọn hỗ trợ tối đa 2.000 sản phẩm/hãng/mẫu/nhà cung cấp và 500 đơn mới nhất; hệ thống lớn hơn cần tìm kiếm lựa chọn từ server.

## Kiểm thử

```sh
npm test
npm run test:operations:integration
```

Integration test cần quyền tạo/xóa database riêng `shoppc_ops_test_*`, tự tạo fixture và dọn database trong `finally`; không ghi fixture vào database cửa hàng. `--serve` giữ API QA ở cổng 3100 để kiểm tra giao diện. Nhập `stop` rồi Enter để kết thúc và dọn, tránh đóng cưỡng bức tiến trình trên Windows.

Trong admin:

```sh
npm run build
npm run lint
node scripts/test-product-csv.cjs
```
