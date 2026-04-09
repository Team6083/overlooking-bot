FROM node:lts-alpine
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm install --ci

COPY . .

RUN npm run build

CMD ["node", "dist/app.js"]