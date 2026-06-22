FROM node:20-slim
RUN apt-get update -y && apt-get install -y openssl
WORKDIR /app
COPY package*.json ./
RUN npm install
RUN npm install -g tsx
COPY prisma ./prisma/
RUN npx prisma generate
COPY . .
EXPOSE 8084
CMD ["tsx", "src/server.ts"]
