# 🍅 番茄每日完结小说抓取

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D18-brightgreen.svg)](package.json)
[![Docker](https://img.shields.io/badge/docker-ready-blue.svg)](Dockerfile)

每天自动抓取番茄小说「已完结且当天有最后章节更新」的全量书单，提供 Web UI 操作界面与定时调度。

## ✨ 特性

- **Web UI** — 浏览器中选择日期、一键抓取、实时进度展示、表格排序查看、JSON 下载
- **定时调度** — 可配置每天自动抓取（如每晚 23:50），持久化配置不丢失
- **数据完整** — 书名、作者、分类、字数、在读人数、封面、完结时间等全字段
- **Docker 一键部署** — 内置 Chrome，NAS / 服务器开箱即用

## 📦 快速开始

### 本地运行

**环境要求**：Node.js >= 18

```bash
# 安装依赖
npm install

# 启动 Web UI（自动打开浏览器）
node ui_server.js

# 或直接命令行抓取
node fanqie_daily_completed.js                        # 今天
node fanqie_daily_completed.js --date 2026-07-30      # 指定日期
```

启动后访问 `http://localhost:8787`，选择日期即可开始抓取。

### Docker 部署

```bash
docker compose up -d --build
```

- 访问 `http://<IP>:8787`
- 数据持久化在 `./output/` 目录
- `restart: unless-stopped` 保证重启后服务自动拉起

> 端口冲突：修改 `docker-compose.yml` 左侧端口，如 `"8899:8787"`

## ⚙️ 配置

### 命令行参数

| 参数 | 默认值 | 说明 |
|------|--------|------|
| `--date YYYY-MM-DD` | 北京今天 | 目标日期 |
| `--output ./data` | ./output | 输出目录 |
| `--delay 600` | 600ms | 列表 API 翻页间隔 |
| `--detail-delay 350` | 350ms | 书籍信息 API 调用间隔 |
| `--max-pages 200` | 200 | 列表最多翻页数 |

### 定时调度配置

首次部署时，复制配置模板：

```bash
cp scheduler_config.json.example scheduler_config.json
```

也可在 Web UI 的「自动抓取」卡片中直接开启/关闭、修改触发时间。

### 常驻运行

```bash
# pm2（推荐）
npm i -g pm2
pm2 start ui_server.js --name fanqie
pm2 save && pm2 startup
```

## 📊 输出格式

结果保存在 `output/fanqie_completed_YYYY-MM-DD.json`：

```json
{
  "fetch_date": "2026-08-01",
  "fetch_time": "2026-08-01T06:33:58.045Z",
  "timezone": "Asia/Shanghai",
  "total_count": 351,
  "stats": {
    "api_calls": 45,
    "books_scanned": 810,
    "detail_failures": 3
  },
  "books": [
    {
      "book_id": "123456",
      "title": "书名",
      "author": "作者",
      "categories": ["都市"],
      "word_count": 500000,
      "read_count": "12345",
      "completion_time": "2026-08-01 22:30:00",
      "url": "https://fanqienovel.com/page/123456"
    }
  ]
}
```

## 🔧 技术方案

1. **列表收集**：在 `fanqienovel.com/library` 页面内通过同源 fetch 调用书库 API，bdms SDK 自动附加 `a_bogus` 签名；`creation_status=0` 只看完结、`sort=1` 按更新时间倒序。
2. **明文补全**：通过书籍信息 API `/api/book/info?bookId=` 获取明文字段，并二次校验完结状态。

> 切勿直接请求 App 端 API（`api5-normal-lf.fqnovel.com`）：跨域 + 无签名必失败。  
> 切勿用详情页 `page.goto` 批量提取：约 270 次页面加载即触发风控。

## ⚠️ 口径说明

番茄不公开「标记完结的时间」，本工具抓取的是**已完结且最后章节更新时间在当天**的小说：
- 完结后当天又更新番外/修订的书也会命中（无法区分）；
- D 日完结但 D 日后又有番外更新的书，回填 D 日时会漏。

**建议每天定时运行（如 23:55），口径最准。** 单日约 700 本，全程约 10 分钟。

## 🤝 贡献

欢迎提交 Issue 和 Pull Request。

1. Fork 本仓库
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add some amazing feature'`)
4. 推送到分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

## 📄 许可证

[MIT](LICENSE)

## 🔗 相关链接

- [番茄小说官网](https://fanqienovel.com)
- [Puppeteer 文档](https://pptr.dev/)
