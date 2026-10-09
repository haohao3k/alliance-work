# Alliance Work — hướng dẫn nhanh

Bắt đầu bằng **một room, một Supervisor và một kết quả rõ ràng**. Agent tự chọn cách làm và gọi thêm role khi cần. Không phải tạo đủ năm role cho mỗi việc.

## 1. Cài đặt và kiểm tra auth

Làm phần [Install](../README.md#install), rồi kiểm tra:

```sh
alliance-work auth codex --from "$HOME/.codex"
alliance-work auth status
alliance-work doctor
```

Cả **HQ, Supervisor, Lead, Peer và Lens** dùng nguồn auth Codex này. Mỗi role vẫn có config,
skills, instructions và lịch sử riêng. Nếu auth nguồn hết hạn, làm mới đăng nhập ở Codex gốc rồi
tiếp tục; không cần login lại từng role. Xem [vận hành và auth](operations.md#authentication)
cho giới hạn refresh, đăng nhập riêng và Claude/Pi.

Mở [127.0.0.1:6771](http://127.0.0.1:6771) và chọn **Alliance Work**.

## 2. Tạo room cho project

Tạo thư mục project trước; có thể dùng một repository đang có. Trong **Alliance Work → New room**, nhập:

- **Room title:** tên dễ nhận biết, ví dụ `Focus Board`.
- **Project directory:** đường dẫn tuyệt đối đến thư mục project.
- **Room mission:** kết quả cần đạt, giới hạn và cách biết đã hoàn thành.

Bấm **Create room**. Một checkout chỉ có một room. Room và mission được lưu, vẫn còn sau khi tải lại trang.

![Room Focus Board đã tạo](assets/room-ready.jpg)

## 3. Giao assignment đầu tiên

Ở **Start an assignment**, chọn role → harness → model. Với Codex dùng auth chung, mọi role đều nhận nguồn auth đã chọn. Với Claude/Pi hoặc Codex đăng nhập riêng, chuẩn bị auth cho các role sẽ tham gia.

| Role | Khi nào dùng |
| --- | --- |
| Supervisor | Chịu trách nhiệm kết quả của project, phân công và kiểm tra bàn giao |
| Lead | Phụ trách một nhánh công việc có phạm vi riêng |
| Peer | Thực hiện một nhiệm vụ, tự điều tra và quyết định kỹ thuật trong phạm vi đó |
| Lens | Đưa một góc nhìn hoặc đánh giá có bằng chứng |
| HQ | Điều phối ưu tiên và ranh giới giữa nhiều nhóm công việc |

Với bài thử này, chọn **supervisor → codex → GPT-6.1-Sol**. Assignment nên nêu **kết quả, phạm vi, bằng chứng**. Ví dụ:

> Đọc README.md và hoàn thành Focus Board trong project này. Giao một phần triển khai có ranh giới rõ cho một alliance-codex-peer qua native Paseo. Tự kiểm tra candidate của Peer, chạy npm test và ghi HANDOFF.md với kết quả, bằng chứng, giới hạn còn lại và commit. Chỉ sửa project này cùng artifact của room; không deploy. Được phép tự quyết định thiết kế và cách triển khai trong phạm vi trên.

Bấm **Start supervisor** để mở chat native. Assignment chỉ được lưu chính thức khi gửi; nội dung đang gõ trong form có thể mất khi tải lại trang. Bản assignment đầy đủ của demo được lưu riêng trong `alliance-work-demo/ASSIGNMENT.md` để dùng lại.

![Chọn role, model và soạn assignment](assets/assignment-ready.jpg)

## 4. Theo dõi và tiếp tục

Trở lại room để xem các thành viên; **Open chat** mở cuộc hội thoại native của từng agent. **Refresh** đọc lại trạng thái.

**Resume → Continue assignment** dùng khi agent đã dừng hoặc đang idle và còn việc phải làm. Nếu có yêu cầu quyền đang chờ, xử lý trong chat trước. Khi agent còn chạy, dùng chat để chủ động điều chỉnh; không gửi lặp cùng một assignment.

Agent kết thúc một lượt chưa có nghĩa sản phẩm đã đạt yêu cầu. Đọc phần bàn giao, kiểm tra candidate và chạy các kiểm tra phù hợp với project.

## 5. Nghiệm thu đúng candidate

Mở **Disposition** ở thành viên chịu trách nhiệm bàn giao:

1. **Candidate identity:** commit SHA hoặc artifact cố định đang được đánh giá.
2. **Disposition evidence:** đã kiểm tra gì, kết quả ra sao, còn thiếu gì.
3. Chọn **Accept candidate** khi đạt; chọn **Reject candidate** nếu cần làm tiếp.

Một lượt làm việc mới mở lại trạng thái acceptance; quyết định trước vẫn được giữ trong artifact của room. Assignment, kết quả lượt chạy và quyết định nằm dưới `~/.alliance-work/rooms/<room-id>/`.

## Cập nhật

```sh
alliance-work update --check
alliance-work update
alliance-work doctor
```

Kết thúc agent và workspace script đang chạy trước khi update. Room, assignment và lịch sử được
giữ lại. Dùng `alliance-work setup --refresh` khi cần nạp lại asset từ phiên bản đang cài;
`alliance-work rollback` quay về bản cài trước. Xem [hướng dẫn vận hành](operations.md#updates-and-recovery).

## Demo Focus Board

Project mẫu ở `~/Desktop/Projects-AI/Paseo/alliance-work-demo`, room **Focus Board · demo**.
Assignment yêu cầu thêm/chuyển/lọc/xóa task, lưu qua reload và dùng được bằng bàn phím.
Các ảnh trên được chụp từ UI thật. Video setup ghi thao tác theo từng đoạn, cắt thời gian chờ.
Lượt model đã tạo được Supervisor và Peer; demo chưa được nghiệm thu đầy đủ, nên video setup
không phải bằng chứng hoàn tất delegation → candidate → acceptance.
