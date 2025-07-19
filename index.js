// index.js
const express = require('express');
const app = express();
const port = process.env.PORT || 3000;

// Basic health check route
app.get('/', (req, res) => {
  res.json({
    status: 'OK',
    message: 'Bot is running successfully',
    timestamp: new Date().toISOString()
  });
});

// Start the server
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
