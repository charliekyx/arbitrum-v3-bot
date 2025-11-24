FROM node:20-alpine

WORKDIR /app

COPY package*.json ./
RUN npm install

COPY . .

RUN npm run build

# Create placeholder state file
RUN echo '{"tokenId": "0", "lastCheck": 0}' > dist/bot_state.json

# Start
CMD ["node", "dist/main.js"]