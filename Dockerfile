FROM node:24.19

WORKDIR /app
COPY . .

RUN corepack enable &&\
    yarn install && \
    yarn build
