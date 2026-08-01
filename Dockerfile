# 番茄每日完结小说抓取 · All-in-One 镜像
# 基于 Debian slim，内置 Chrome for Testing（puppeteer 管理）+ 全部运行库
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PORT=8787 \
    OUTPUT_DIR=/app/output \
    SCHED_FILE=/app/output/scheduler_config.json \
    NO_OPEN=1 \
    PUPPETEER_CACHE_DIR=/app/.cache/puppeteer

# Chrome 无头模式所需系统库 + 中文字体（无中文字体可能导致页面渲染/截图缺字）
RUN apt-get update && apt-get install -y --no-install-recommends \
      ca-certificates \
      fonts-liberation fonts-noto-cjk \
      libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
      libdbus-1-3 libdrm2 libgbm1 libglib2.0-0 libgtk-3-0 \
      libnspr4 libnss3 libpango-1.0-0 \
      libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxdamage1 libxext6 \
      libxfixes3 libxkbcommon0 libxrandr2 libxss1 libxtst6 \
      xdg-utils \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# 先装依赖并下载 Chrome（利用镜像层缓存：仅 package.json 变化才重装）
COPY package.json ./
RUN npm install --omit=dev \
    && npx puppeteer browsers install chrome

# 再拷源码
COPY ui_server.js fanqie_daily_completed.js ui.html scheduler_config.json.example ./

EXPOSE 8787

# 数据（结果 JSON + 调度配置）统一落在 /app/output，挂载宿主机目录即可持久化
VOLUME ["/app/output"]

CMD ["node", "ui_server.js", "--no-open"]
