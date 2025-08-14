FROM node:18-alpine

WORKDIR /app

# Copy package.json and install dependencies
COPY package.json .
RUN npm install --production

# Copy server code
COPY cloud-server.js .

EXPOSE 8080

CMD ["node", "cloud-server.js"]