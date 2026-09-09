FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
ENV PORT=3000
ENV DB_PATH=/data/gouinche.db
EXPOSE 3000
CMD ["node", "server.js"]
