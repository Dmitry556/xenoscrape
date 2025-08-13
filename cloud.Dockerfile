FROM node:18-alpine

WORKDIR /app

COPY cloud-package.json package.json
RUN npm ci --only=production

COPY cloud-server.js .

EXPOSE 8080

CMD ["npm", "start"]