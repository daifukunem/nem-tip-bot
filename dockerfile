FROM library/node:latest
RUN mkdir /code
COPY ./LICENSE /code/LICENSE
COPY ./package.json /code/package.json
COPY ./config /code/config
COPY ./migrations /code/migrations
COPY ./models /code/models
COPY ./seeders /code/seeders
COPY ./app.js /code/app.js
RUN cd /code; npm i --production;
CMD ["npm", "start"]