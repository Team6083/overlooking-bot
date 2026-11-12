FROM node:lts-alpine
WORKDIR /usr/src/app

COPY package*.json ./
RUN npm ci

COPY . .

RUN npm run build

# Sent as X-App-Version / X-App-Commit, e.g. --build-arg APP_VERSION=1.2.3 --build-arg APP_COMMIT=$(git rev-parse --short HEAD)
ARG APP_VERSION=dev
ARG APP_COMMIT=unknown
ENV APP_VERSION=$APP_VERSION APP_COMMIT=$APP_COMMIT

CMD ["node", "dist/app.js"]