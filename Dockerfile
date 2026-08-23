FROM mcr.microsoft.com/playwright:v1.49.0-jammy

WORKDIR /app

# 의존성 먼저 (레이어 캐시)
COPY package*.json ./
RUN npm ci --omit=dev || npm install --omit=dev

# 소스 복사
COPY . .

ENV NODE_ENV=production
ENV DATA_DIR=/data

# Node 힙과 크로뮴 몫을 명시적으로 갈라 둔다.
# 이 컨테이너의 메모리는 사실상 크로뮴이 쓴다(실측 1회 수집에 약 334MB).
# 상한을 안 걸면 Node 힙 상한이 기본 약 4.3GB 로 잡힌다. 실제로 그만큼 쓰진 않지만,
# 자랄 수 있는 만큼 자라고 나면 크로뮴이 기동할 자리가 남지 않는다 — 그 결과가
# 'launch 직후 죽음' 이다. 그래서 Node 쪽에 명시적인 천장을 둔다.
#
# 값의 근거(실측): 수집 1회의 Node heapUsed 피크 29MB, RSS 피크 101MB.
# 힙에 남는 것은 카드 스냅샷 317건과 로그 200줄이 전부다. 128MB 면 실사용의 4배가 넘는다.
# 프로그램 수가 몇 배로 늘어도 여유가 있고, 모자라면 재빌드 없이 Railway 변수로 올린다.
ENV NODE_MAX_OLD_SPACE_MB=128

EXPOSE 3000

# exec 로 감싸 node 가 PID 1 이 되게 한다 — 안 그러면 Railway 의 SIGTERM 이 sh 에서 멈춘다.
CMD ["sh", "-c", "exec node --max-old-space-size=${NODE_MAX_OLD_SPACE_MB:-128} src/server.js"]
