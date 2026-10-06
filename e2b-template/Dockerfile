FROM e2bdev/code-interpreter:latest

WORKDIR /home/user
RUN npm init -y && npm i playwright
RUN npx playwright install-deps chromium

USER user
RUN npx playwright install chromium

USER root