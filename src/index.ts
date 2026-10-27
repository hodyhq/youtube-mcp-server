import 'dotenv/config';
import { startMcpServer } from './server.js';
import { hasConfiguredYouTubeApiKey } from './services/youtube-client.js';

// Warn rather than exit: keys are validated lazily on the first tool call, and exiting
// here leaves clients that pass a minimal environment with only "Connection closed" (issue #31).
if (!hasConfiguredYouTubeApiKey()) {
    console.error('Warning: no YouTube API key found. Set YOUTUBE_API_KEY, YOUTUBE_API_KEY2, or YOUTUBE_API_KEY3.');
    console.error('The server will start, but tools that call the YouTube Data API will fail until a key is set.');
}

// Start the MCP server
startMcpServer()
    .then(() => {
        console.error('YouTube MCP Server started successfully');
    })
    .catch(error => {
        console.error('Failed to start YouTube MCP Server:', error);
        process.exit(1);
    });
