# 用户更新摘要

这里只记录用户能感知的变化；英文技术细节见 CHANGELOG.md。

## [1.6.134] - 2026-10-04

### 本阶段更新汇总（1.6.90～1.6.133）
- [delegation|委派任务] 默认开启多 Agent 委派；Git 项目最多 5 个 Worker 隔离并行，成果由主 Agent 确认合并，非 Git 目录仍串行。
- [dsh-backend|DSH 后端] 新增 DSH 后端，支持模型与 effort 切换、上下文续接，以及在 /status 中查询余额。
- [file-attachments|文件附件] 支持接收最大 20 MiB 的文件，提取文本文件、文字型 PDF、DOCX 和 XLSX 内容；设备授权后，上传文件再发送处理指令即可。
- [worker-cards|任务卡片] 优化手机端的进度和结果展示，支持 Markdown 富文本；Worker 活动详情和后台任务结果默认折叠。
- [execution-metadata|执行信息] 主 Agent 和子 Agent 卡片底部都用小号灰字显示各自的模型与 effort，方便了解本次任务的执行配置。
- [maintenance-notices|更新与额度提醒] 新增中文升级摘要与 Codex Reset 额度提醒；跨版本升级时按功能汇总变化，重启和升级后保留已确认送达的提醒记录。
