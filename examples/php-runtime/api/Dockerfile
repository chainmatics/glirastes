FROM php:8.4-cli-alpine
WORKDIR /app
COPY api/ /app/
USER 65534:65534
EXPOSE 8080
CMD ["php", "-S", "0.0.0.0:8080", "/app/router.php"]
