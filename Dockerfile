FROM node:18-alpine

WORKDIR /app

# Copy and install dependencies first
COPY cloud-package.json package.json
RUN npm install --production

# Copy server code
COPY cloud-server.js .

EXPOSE 8080

CMD ["node", "cloud-server.js"]