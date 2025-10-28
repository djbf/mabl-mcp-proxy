FROM node:24-alpine AS build
WORKDIR /app

# Install build toolchain for native dependencies if needed
RUN apk add --no-cache python3 make g++ git

COPY package.json tsconfig.json .eslintrc.cjs ./
COPY src ./src

RUN npm install
RUN npm run build
RUN npm prune --omit=dev

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production

COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/dist ./dist

EXPOSE 443
EXPOSE 80

CMD ["node", "dist/index.js"]
