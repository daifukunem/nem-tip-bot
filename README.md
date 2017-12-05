## Node.js tip bot for NEM.

### How to Install

```sh
$ git clone https://github.com/daifukunem/nem-tip-bot.git
$ cd nem-tip-bot
$ npm install
$ cp .env.example .env
```

Edit .env for your configuration.

### How to run
```
$ npm start
```

### Docker

For those that want to run the bot in a docker container
use the following command

```
docker run -d \
-v $(pwd)/nem-tipbot.sqlite:/code/nem-tipbot.sqlite \
-v $(pwd)/.env:/code/.env \
--restart always \
--name nem-tip-bot daifukunem/nem-tip-bot:latest
```

copy the .env.example to $(pwd)/.env and replace as needed.

That's it!

Please submit PR and Issues.