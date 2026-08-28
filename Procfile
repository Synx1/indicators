# ONE process. index.js is the Discord panel, the trading loop and the web dashboard, which is
# what lets the site read the same in-memory book the trader writes instead of a file on disk.
# Two processes would also fight over $PORT.
web: node index.js
