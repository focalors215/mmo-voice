FROM node:22.23.3-alpine
RUN apk add --no-cache chromium font-noto-cjk
WORKDIR /qa
COPY package*.json ./
RUN npm install --ignore-scripts
CMD ["node","smoke.mjs"]
