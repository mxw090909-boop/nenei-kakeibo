# 年年の家計簿

手机优先的个人记账前端。支持 CSV 导入、分类规则、月报仪表盘、交易明细编辑和现金补录。

## 本地预览

```bash
npm install
npm run dev
```

## GitHub Pages

仓库内已包含 GitHub Pages Actions workflow。推送到 `main` 后，会自动构建并发布到 Pages。

## VPS 云同步

前端可以在设置页填写 VPS API URL 和 Token。Token 不会写进 GitHub Pages 代码，只保存在当前浏览器的 localStorage。

VPS 端参考实现：

```bash
cd /path/to/nenei-kakeibo
python3 -m venv .venv
. .venv/bin/activate
pip install -r server/requirements.txt
KAKEIBO_SYNC_TOKEN='change-me' \
KAKEIBO_DB='/opt/codex-tg/kakeibo.sqlite3' \
python3 server/kakeibo_sync_api.py
```

同步接口：

- `GET /api/kakeibo/sync/pull?since=...`
- `POST /api/kakeibo/sync/push`
- `GET /api/kakeibo/health`

## 这版修正

- 从单个 TSX 文件整理为完整 Vite React 项目
- localStorage 持久化，普通浏览器刷新后数据不会消失
- CSV 导入支持 UTF-8 / Shift_JIS(CP932) 自动识别
- 金额解析支持 `¥1,234` / `1,234円` / 负数
- 日期统一标准化为 `YYYY-MM-DD`
- 导入预览增加样本检查、异常行统计、重复项默认跳过
- 增加交易 type：expense / refund / transfer / charge / excluded
- 支持拖拽导入 CSV
