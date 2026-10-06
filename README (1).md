# Instagram Comments Automation

A small local Instagram-only dashboard for posting user-written comments from saved Instagram accounts.

## Included

- Instagram account login and saved Playwright sessions
- Optional stable proxy per account
- Proxy IP test
- Multiple unique comments for one reel/post
- Auto account allocation or manual account selection
- One unique account per comment
- Custom gap in minutes before each comment after the first
- Same account is not automatically used twice on the same reel/post
- Browser stays on the reel/post for about 35 seconds after a submission before closing
- Jobs and used-account history are saved in `data/` so a restart does not intentionally re-post the same in-progress comment

## Not included

- TikTok
- AI/Groq comment generation
- View counting or view thresholds
- Likes, saves, or shares
- Random timing, shuffling, or proxy rotation

## Setup

1. Run `INSTALL.bat` once.
2. Run `START.bat`.
3. Open `http://127.0.0.1:4610` if the browser does not open automatically.
4. Log in Instagram accounts. Add a stable proxy before login if desired.
5. Paste a reel/post URL.
6. Add as many different comments as you need.
7. For comment 2 onward, set the exact wait in minutes after the previous comment finishes.
8. Choose Auto assign or Select accounts.
9. Start the comment queue.

## Account/reel rule

Once an account has posted a comment on a reel/post (or a submission became uncertain after it was attempted), the local history reserves that account for that reel/post. This avoids automatically sending another comment from the same account to the same target.

History file: `data/comment-history.json`
Job state file: `data/comment-jobs.json`
Proxy credentials: `data/private/account-proxies.json`

Keep the server running while a timed queue is active. Pending queues are persisted and are resumed after a normal restart; an item that was actively posting when the server stopped is not retried automatically, to avoid duplicate comments.
