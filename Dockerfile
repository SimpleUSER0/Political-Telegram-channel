FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app
COPY pyproject.toml requirements.lock ./
RUN pip install --require-hashes -r requirements.lock
COPY src ./src
COPY alembic.ini ./
COPY migrations ./migrations
RUN pip install --no-deps . && useradd --system --uid 10001 newsroom
USER newsroom
EXPOSE 8080
CMD ["political-agent", "serve"]
