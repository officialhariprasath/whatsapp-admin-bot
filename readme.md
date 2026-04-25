npm install express axios dotenv xlsx cors

how to find and kill a running port
Step 1: Find which process is using port 3000

Run:

netstat -ano | findstr :3000

You’ll see something like:

TCP    0.0.0.0:3000    0.0.0.0:0    LISTENING    12345

The last number (12345) is the PID.

Step 2: Kill that process

Run:

taskkill /PID 12345 /F

Replace 12345 with your actual PID.
s
/F means force kill.