FROM node:24-alpine
WORKDIR /app
COPY server.js index.html backend-client.js media-viewer.js media-viewer.css docker-entrypoint.sh ./
ENV NODE_ENV=production PORT=8080 DATA_DIR=/data
RUN apk add --no-cache su-exec && mkdir /data && chown node:node /data
EXPOSE 8080
ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]
