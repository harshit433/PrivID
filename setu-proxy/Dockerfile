FROM node:20-bookworm-slim
WORKDIR /app
COPY package.json server.js ./
ENV PORT=8080
EXPOSE 8080
CMD ["node", "server.js"]
