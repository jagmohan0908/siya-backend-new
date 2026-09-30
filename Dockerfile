FROM node:22-alpine
WORKDIR /app
COPY --chown=node:node package.json doctor-policy.json ./
COPY --chown=node:node src ./src
USER node
ENV HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "src/server.mjs"]
