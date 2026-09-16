FROM oven/bun:1
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile --production
COPY *.ts ./
COPY public ./public
ENV PORT=3000 DATA_DIR=/data
EXPOSE 3000
CMD ["bun", "server.ts"]
