# Alliance Work

Mở project bằng giao diện native của Paseo, chọn profile **Alliance HQ / Supervisor / Lead / Peer / Lens**, rồi giao việc trong chat.

## Room tự động

Chưa có room cho thư mục thì Alliance tạo một room khi mở profile. Đã có thì dùng lại,
không đổi mission hay tạo bản sao. Worktree khớp duy nhất một room của repository cũng dùng lại
room đó. Nếu nhiều room cùng repository khiến việc chọn mơ hồ, thêm chính đường dẫn checkout
bằng **Alliance Work → Add project**.

**Add project** cho phép gõ `~/`, đường dẫn tuyệt đối, hoặc chọn thư mục trong danh sách.
Thư mục được đọc trên host đang chọn. Không cần nhập tên, mission hay assignment ở đây.

## Theo dõi

**Alliance Work** hiển thị agent theo project: tên, role, model, trạng thái và thời điểm cập nhật.
Chọn **Working**, **Attention**, **Idle**, lọc project hoặc tìm theo tên. **Open** mở đúng session
trên đúng host. **Archived** hiện thêm session đã lưu trữ. Bảng tự cập nhật; lỗi đọc hiển thị rõ
khi dữ liệu cũ vẫn còn trên màn hình.

Gửi việc mới, tiếp tục, xử lý permission và kiểm tra bàn giao trong chat native. Agent idle chỉ
có nghĩa không chạy lượt hiện tại; không đồng nghĩa công việc đã được nghiệm thu. Assignment,
kết quả và các quyết định cũ vẫn nằm dưới `~/.alliance-work/rooms/<room-id>/`.

## Model theo room

Mở **Alliance Work → Models** ở project cần chỉnh. Chọn mức `routine`, `standard`, `complex`
hoặc `frontier`, thêm model/effort từ catalog thật, bỏ lựa chọn không muốn dùng và chỉnh priority.
Số nhỏ được ưu tiên hơn; **Save model settings** lưu riêng cho room trên host đó. Các band có
thể dùng chung một route. **Reset defaults** chỉ sửa bản nháp, cần Save mới áp dụng.

Peer/Lens mặc định ưu tiên Sol high hoặc Opus 5.5 medium cho việc triển khai; có Sonnet 5.5
xhigh cho việc complex, Astra high cho frontier. Lead tự đánh giá độ khó và quyết định cuối
cùng trong allowlist; Supervisor/HQ có thể can thiệp bằng lý do và bằng chứng. Priority không
ép phải thử model đầu tiên. Không có classifier tự đọc prompt để định độ khó, và không tự
đổi model đang chạy. HQ/Supervisor giữ lựa chọn model độc lập với allowlist Peer/Lens.

Lead **ưu tiên GPT-6 Astra hoặc Claude Opus 5.5, medium/high**, nhưng được chọn model/effort khác
trong catalog thật khi phù hợp task. Đây là ưu tiên, không phải điều kiện chặn tạo Lead; allowlist
Peer/Lens không giới hạn model của Lead. Settings cho chỉnh effort ưu tiên khi không chỉ định.
Nếu model không hỗ trợ effort ưu tiên thì dùng mặc định khả dụng của model. Model/effort được
chọn tường minh nhưng không có trong catalog vẫn báo lỗi, không tự đổi ngầm.

Gate kiểm tra mọi lượt **tạo agent Alliance** qua UI/native `create_agent` và RPC. Native
delegation chỉ có model/effort nên gate kiểm tra hợp của allowlist; band độ khó là hướng dẫn
cho Lead. RPC `members.launch` có `difficulty` thì kiểm tra thêm band được chọn. Bỏ model/effort
sẽ lấy route khả dụng theo priority, ưu tiên band standard khi không chỉ định độ khó.

Settings áp dụng cho **launch mới**. Phiên đang mở giữ context cũ; SDK Paseo hiện chưa có hook
chặn đổi model/effort ngay trong phiên. Khi đổi policy, owner cần bàn giao assignment sang phiên
mới; không coi đây là giới hạn chi phí cưỡng chế cho mọi lệnh native/harness. Không tự ngắt phiên.

Policy chung của Alliance nằm trong `room/policies/agent-ownership.md`, `operating-contract.md`
và `model-selection.md`, được nạp cho mọi role. Đây là phần tương đương general policy; vendor
Seatwork giữ nguyên. [Nguyên tắc chọn model và nguồn OpenAI/Anthropic](../room/policies/model-selection.md).

## HQ nhiều host

Workspace HQ giữ danh bạ host và các con trỏ project. HQ dùng Paseo CLI với `--host` để đọc
trạng thái và message, rồi giao việc trong phạm vi Human đã giao. Native Paseo MCP thao tác trên
host của session. Luôn ghi cả host và agent ID; host mất kết nối là chưa biết trạng thái.
HQ có thể dùng Piggery CLI cho project dùng Piggery, nhưng không tự coi mình đã có participant ID.

## Auth và cập nhật

```sh
alliance-work auth status
alliance-work doctor
alliance-work update --check
alliance-work update
```

Xem [cài đặt và auth](../README.md) và [vận hành](operations.md). Cập nhật chờ agent và workspace
script idle rồi hot reload plugin; không restart daemon đang chạy.

## Demo Focus Board đã nghiệm thu

Project mẫu ở `~/Desktop/Projects-AI/Paseo/alliance-work-demo`, room **Focus Board · demo**.
Supervisor đã giao việc qua native Paseo cho Peer, nhận candidate, review và chạy lại **11/11 test**;
`npm start` cũng đã được kiểm tra. Host đã thao tác trên UI thật: thêm task, từ chối nội dung rỗng,
đổi trạng thái, lọc/xóa, reload giữ dữ liệu, dùng bàn phím và kiểm tra bố cục 390px/1280px.

- Candidate triển khai: `f20ebfb14bb9e95523ef28375012bfe84f17c76d`.
- Commit có `HANDOFF.md` hoàn chỉnh: `a589487e056efa30e0b3d35dd0f1e99fbea9b79f`; code ứng dụng giữ nguyên.
- Cả Peer và Supervisor đều **accepted** bằng Disposition riêng; trạng thái vẫn còn sau reload.

![Focus Board do Peer triển khai](assets/focus-board.jpg)

[Xem hoặc tải video demo](https://github.com/haohao3k/alliance-work/releases/download/v0.1.3/alliance-work-demo.mp4) · [Phụ đề tiếng Việt](https://github.com/haohao3k/alliance-work/releases/download/v0.1.3/alliance-work-demo.vi.vtt).
Video dùng các frame UI chụp thật, có phụ đề tiếng Việt; đã cắt thời gian chờ và các lượt cấp quyền lặp,
làm chậm một số thao tác ngắn để dễ theo dõi. Không phải bản ghi liên tục toàn phiên.
Repo private nên cần tài khoản GitHub có quyền truy cập. Có thể tải bằng CLI:

```sh
gh release download v0.1.3 --repo haohao3k/alliance-work --pattern alliance-work-demo.mp4
```

Bài này chạy model thật bằng **Codex Supervisor và Peer**. Claude/Pi đã được kiểm tra native home và
skill discovery, chưa chạy bài model acceptance này. Các kiểm tra UI không thay thế một audit
accessibility hoặc kiểm tra mọi trình duyệt. Auth và giới hạn refresh nằm trong [operations](operations.md#authentication).

## Skill theo project và evidence gắn candidate

Mỗi project đăng ký các thư mục `.agents/skills/<name>` qua `alliance-work skills add PATH`.
Manifest `.alliance/skills.json` đi cùng repository/worktree. Session mới nạp đúng selection;
session đang chạy không bị ngắt. Claude dùng một plugin chỉ chứa skill đã chọn; Codex/Pi nạp
skill được chọn qua discovery/đường dẫn native. Không nhập cấu hình cá nhân hoặc project hooks/MCP.
Tên `slp-*` và `alliance-*` dành cho playbook managed; phần mở rộng dùng tên project của mình.

Dùng `alliance-work verify --scenario NAME --kind test -- COMMAND ARGS` để chạy check đã chọn.
`runtime` chỉ dành cho check thật sự đi qua hành vi runtime; `analysis` cho kiểm tra phân tích.
`--target` mô tả instance được thao tác; đây là nhãn của owner, không thay cho driver xác minh
đúng endpoint. `--input FILE` đưa cấu hình bị Git ignore vào fingerprint; `--artifact FILE`
gắn screenshot/trace; `--unverified REASON` giữ phạm vi chưa thử. Các tùy chọn sau repeat được.
Không có Git thì dùng `--input` để chỉ rõ các file candidate. Không đưa secrets vào command line.

CLI trả đường dẫn report, digest và verdict PASS/FAIL/BLOCKED/STALE. Command thay đổi candidate
trong lúc chạy sẽ STALE. Owner đọc report rồi gọi `alliance-work accept --agent ID --report PATH`.
Có thể chạy command bằng đường dẫn Node/CLI tuyệt đối trong room context khi PATH chưa có launcher.
Không cần thêm reviewer hoặc model family; Lead tự quyết phạm vi check và review. Proof từ unit
test không được diễn giải thành UI đã chạy. Acceptance không cấp quyền publish/merge/deploy.

Bản ghi native assignment được tạo khi mở session, kể cả khi giao việc bằng native create_agent.
Nó trỏ tới conversation giữ nguyên lời giao việc; hook Paseo không cung cấp initial prompt nên
Alliance không dựng lại nội dung đó. Owner vẫn lưu/link brief và acceptance conditions khi cần.
Mapping đầy đủ của tên tool/đường dẫn Seatwork nằm trong operating instructions của mỗi role.
Các disposition cũ được giữ nguyên như quyết định lịch sử, không tự nâng thành proof đã xác minh.


## Coverage và học từ failure

`alliance-work verify --map .alliance/features.json --feature ID` chỉ tính coverage khi assertion
đã chạy và pass. Có thể lặp `--feature`, hoặc bỏ để chạy toàn map. Report giữ rõ phạm vi bỏ ngoài,
check skip/blocked và hành vi chưa được chứng minh. Lead chọn phạm vi; không bắt tạo map cho việc nhỏ.

Dùng `alliance-work eval --suite .alliance/evals/NAME.json` để so cùng bộ case giữa baseline và bản
sửa. Report lưu failure evidence, candidate, từng lần chạy và regression; `eval inspect --report PATH`
kiểm tra evidence còn nguyên. Không tự cài skill hoặc đổi policy. Nếu bản sửa có ích, Lead quyết định
đăng ký skill và link bài học vào notebook/handoff hiện có. Xem [schema và driver](verification.md).


## Hẹn quay lại công việc

Dùng `alliance-work wakeups add` khi cần xem lại một job, một lượt của Peer hoặc một thời hạn.
Gắn đúng room, owner và key duy nhất; xem cú pháp trong [operations](operations.md#durable-wakeups-019).
Mặc định `pull` không gửi prompt. Tại ranh giới task, chạy
`alliance-work wakeups take --owner "$PASEO_AGENT_ID"`, đọc kết quả rồi `wakeups ack` với key/revision
được trả về. Ack chỉ xác nhận đã xem; nghiệm thu candidate vẫn là bước riêng.

`--delivery idle` là tùy chọn tự gửi, có gom sự kiện và giới hạn tần suất. Paseo hiện chưa bảo đảm
kiểm tra idle và gửi là một thao tác atomic; dùng pull nếu phiên đang làm việc không được ngắt.
Không tự bật auto-delivery cho các job đang chạy. Nếu delivery là `uncertain`, kiểm tra lịch sử
trước khi ack/cancel, không tạo key mới để gửi lặp.

### Phiên cũ, owner và nghiệm thu sản phẩm

Đầu assignment/turn tự nhiên tiếp theo, agent chạy `alliance-work policy read --agent ID`, đọc
policy rồi `policy ack --agent ID --digest SHA256` với digest vừa nhận. Không gửi ping hàng loạt
để ép phiên đang làm việc cập nhật. Monitor ghi nhận đã đọc, không tuyên bố system prompt đã đổi.

Nếu owner công việc khác native parent, dùng `members owner --agent ID --owner OWNER_ID
--revision N --evidence /absolute/handoff.md`. HQ khác room được nhận wakeup khi có quan hệ owner
rõ ràng. Handoff này không tự chuyển job hoặc wakeup; đối soát các nghĩa vụ đang mở riêng.

Brief giữ mục tiêu người dùng, constraint có nguồn gốc, owner và cách chứng minh kết quả;
phương án kỹ thuật được phép xét lại. Chỉ thêm vòng review khi có câu hỏi quyết định hoặc bằng
chứng mới. Nghiệm thu sản phẩm dùng `accept --report RUNTIME_REPORT --product JOURNEY_JSON`;
format và giới hạn nằm trong `docs/operations.md`. Technical PASS không tự thành product acceptance.


## Luật chung và nghĩa vụ qua session

Mọi role dùng cùng [10 luật lõi](../room/policies/engineering-laws.md). Khi resume hoặc compact,
`alliance-work policy read --agent "$PASEO_AGENT_ID"` trả policy hiện tại và nghĩa vụ còn mở.
Snapshot `$ALLIANCE_CONTEXT` được tạo lại khi mở native session; cần đọc lại trạng thái trước
hành động phụ thuộc. Không có vòng ACK bắt buộc hay broadcast làm ngắt agent.

Chỉ ghi nghĩa vụ cho phần việc cần sống qua lượt làm/session, không ghi từng tool call:
`obligations add --file FILE.json`. Giữ assignment, owner, nguồn quyền, nextAction, closeWhen và
điều kiện chờ. Dùng `obligations action --file FILE.json` để ghi bằng chứng điều kiện, điều chỉnh
premise, bàn giao hoặc đóng có bằng chứng; xem [schema và ví dụ](operations.md#durable-obligations-0111).
Bàn giao chuyển đồng thời nghĩa vụ và reminder/job gắn riêng với nó. Chờ Human là trạng thái hợp lệ.

Reminders gắn `--obligation KEY` chỉ dùng pull. Đến giờ chưa chắc đủ điều kiện; nhận/ACK/hết hạn
reminder không hoàn tất nghĩa vụ. Khi vi phạm luật, dừng đúng hành động phụ thuộc, xem lại premise,
đối chiếu evidence/quyền/owner rồi tiếp tục. Việc độc lập vẫn được tự chủ làm tiếp.
## Tự tiếp tục task dài

Từ 0.1.12, agent được giao việc qua Alliance launch hoặc tạo làm native child được bật autonomy.
Chat cũ giữ nguyên; với task mới ở root, agent chạy `autonomy start` một lần theo room contract.
Có thể bật thủ công bằng CLI đúng instance:

```sh
alliance-work autonomy start --agent AGENT_ID --max-continuations 20 --max-retries 2
alliance-work autonomy list
alliance-work autonomy checkpoint --agent AGENT_ID --phase paused --reason 'Tạm dừng'
```

Cuối mỗi lượt, agent ghi checkpoint: `active` để làm bước kế tiếp, `waiting` để chờ dependency,
`review` khi có kết quả đã kiểm tra, `blocked` khi cần quyết định, `paused` để dừng tự tiếp tục.
Scheduler tự wake agent idle, retry lượt lỗi có backoff và giới hạn, rồi wake owner để nghiệm thu.
Hủy một lượt sẽ pause; permission đang chờ duyệt vẫn cần người có thẩm quyền xử lý.

Archive chỉ diễn ra sau `accept` có bằng chứng gắn với candidate, khi agent idle và không còn
child, trách nhiệm, job hay wakeup chưa xử lý. Muốn giữ chat sau nghiệm thu, dùng
`--auto-archive false` khi start. Không reset budget mỗi lượt. `status` hiển thị state/counter;
`uncertain` cần kiểm tra native history trước khi checkpoint lại, tránh thực hiện trùng side effect.
Chi tiết giới hạn và bài test agent thật ở [operations](operations.md#autonomous-assignments-0112).


Với việc phụ thuộc điều kiện, dùng `autonomy start --agent ID --obligation KEY`: chưa đủ
bằng chứng thì không tự tiếp tục/retry và không tiêu budget. Handoff chuyển cả lifecycle/budget;
owner cũ pause, successor phải idle và chưa có assignment tự chạy khác. Còn nghĩa vụ mở thì
không auto-archive, kể cả reminder đã ACK/hết hạn. Bàn giao cho Human không tự gửi prompt.
