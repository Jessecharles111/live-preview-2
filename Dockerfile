FROM node:18-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install
COPY server.js .
COPY client ./client
RUN cd client && npm install && npm run build
EXPOSE 3000
CMD ["node", "server.js"]
