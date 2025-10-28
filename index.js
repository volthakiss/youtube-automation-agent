const express = require('express');
const path = require('path');
const { Logger } = require('./utils/logger');
const { Database } = require('./database/db');
const { CredentialManager } = require('./utils/credential-manager');
const { ContentStrategyAgent } = require('./agents/content-strategy-agent');
const { ScriptWriterAgent } = require('./agents/script-writer-agent');
const { ThumbnailDesignerAgent } = require('./agents/thumbnail-designer-agent');
const { SEOOptimizerAgent } = require('./agents/seo-optimizer-agent');
const { ProductionManagementAgent } = require('./agents/production-management-agent');
const { PublishingSchedulingAgent } = require('./agents/publishing-scheduling-agent');
const { AnalyticsOptimizationAgent } = require('./agents/analytics-optimization-agent');
const { DailyAutomation } = require('./schedules/daily-automation');
const chalk = require('chalk');

// === AJOUT OAUTH2 GOOGLEAPIS ===
const { google } = require('googleapis');

// Scopes YouTube nécessaires
const SCOPES = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/youtube.upload',
  'https://www.googleapis.com/auth/youtube.channel-memberships',
  'https://www.googleapis.com/auth/youtubepartner',
  'https://www.googleapis.com/auth/youtube.force-ssl',
  'https://www.googleapis.com/auth/youtube.readonly',
  'https://www.googleapis.com/auth/youtube.analytics.readonly',
  'https://www.googleapis.com/auth/youtube.analytics.monetary.readonly'
];

// URI de redirection dynamique
const REDIRECT_URI = process.env.REDIRECT_URI || 
  (process.env.NODE_ENV === 'production' 
    ? 'https://buzzbitfacts.onrender.com/oauth2callback' 
    : 'http://localhost:3456/oauth2callback');

// Création du client OAuth2
const oauth2Client = new google.auth.OAuth2(
  process.env.YOUTUBE_CLIENT_ID,
  process.env.YOUTUBE_CLIENT_SECRET,
  REDIRECT_URI
);

// Injecte oauth2Client dans les variables globales ou CredentialManager
global.oauth2Client = oauth2Client;
global.SCOPES = SCOPES;
// === FIN AJOUT ===

class YouTubeAutomationAgent {
  constructor() {
    this.logger = new Logger('MainAgent');
    this.db = null;
    this.credentials = null;
    this.agents = {};
    this.app = express();
    this.isInitialized = false;
  }

  async initialize() {
    try {
      console.log(chalk.cyan.bold('\n🎬 YouTube Automation Agent v1.0'));
      console.log(chalk.gray('─'.repeat(50)));
      
      // Initialize database
      this.logger.info('Initializing database...');
      this.db = new Database();
      await this.db.initialize();
      
      // Load credentials
      this.logger.info('Loading credentials...');
      this.credentials = new CredentialManager();
      const credentialsValid = await this.credentials.validateAll();
      
      if (!credentialsValid) {
        console.log(chalk.yellow('\n⚠️  Some credentials are missing or invalid.'));
        console.log(chalk.yellow('Run: npm run credentials:setup'));
        return false;
      }
      
      // Initialize agents
      this.logger.info('Initializing agents...');
      await this.initializeAgents();
      
      // Setup API endpoints
      this.setupAPI();
      
      // Initialize scheduler
      this.logger.info('Setting up automation scheduler...');
      this.scheduler = new DailyAutomation(this.agents, this.db);
      await this.scheduler.initialize();
      
      this.isInitialized = true;
      this.logger.success('YouTube Automation Agent initialized successfully!');
      
      return true;
    } catch (error) {
      this.logger.error('Failed to initialize:', error);
      return false;
    }
  }

  async initializeAgents() {
    this.agents = {
      strategy: new ContentStrategyAgent(this.db, this.credentials),
      scriptWriter: new ScriptWriterAgent(this.db, this.credentials),
      thumbnailDesigner: new ThumbnailDesignerAgent(this.db, this.credentials),
      seoOptimizer: new SEOOptimizerAgent(this.db, this.credentials),
      production: new ProductionManagementAgent(this.db, this.credentials),
      publishing: new PublishingSchedulingAgent(this.db, this.credentials),
      analytics: new AnalyticsOptimizationAgent(this.db, this.credentials)
    };

    // Initialize each agent
    for (const [name, agent] of Object.entries(this.agents)) {
      await agent.initialize();
      this.logger.info(`✓ ${name} agent initialized`);
    }
  }

  setupAPI() {
    this.app.use(express.json());
    this.app.use(express.static(path.join(__dirname, 'dashboard')));
    
    // Main dashboard route
    this.app.get('/', (req, res) => {
      res.sendFile(path.join(__dirname, 'dashboard', 'index.html'));
    });
    
    // Health check
    this.app.get('/health', (req, res) => {
      res.json({
        status: 'healthy',
        initialized: this.isInitialized,
        agents: Object.keys(this.agents),
        timestamp: new Date().toISOString()
      });
    });

    // === AJOUT : Route OAuth2 Callback ===
    this.app.get('/oauth2callback', async (req, res) => {
      const { code } = req.query;
      if (!code) {
        return res.status(400).send('No code provided');
      }

      try {
        const { tokens } = await oauth2Client.getToken(code);
        await this.credentials.saveYouTubeTokens(tokens);
        res.send(`
          <h2>✅ Authentification réussie !</h2>
          <p>Tu peux fermer cette page.</p>
          <script>setTimeout(() => window.close(), 3000);</script>
        `);
      } catch (error) {
        res.status(500).send(`Erreur: ${error.message}`);
      }
    });
    // === FIN AJOUT ===

    // Manual content generation
    this.app.post('/generate', async (req, res) => {
      try {
        const { topic, style, length } = req.body;
        const result = await this.generateContent(topic, style, length);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });

    // Get analytics
    this.app.get('/analytics', async (req, res) => {
      try {
        const analytics = await this.agents.analytics.getRecentAnalytics();
        res.json(analytics);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Get upcoming schedule
    this.app.get('/schedule', async (req, res) => {
      try {
        const schedule = await this.db.getUpcomingSchedule();
        res.json(schedule);
      } catch (error) {
        res.status(500).json({ error: error.message });
      }
    });

    // Manual publish
    this.app.post('/publish/:contentId', async (req, res) => {
      try {
        const { contentId } = req.params;
        const result = await this.agents.publishing.publishContent(contentId);
        res.json({ success: true, result });
      } catch (error) {
        res.status(500).json({ success: false, error: error.message });
      }
    });
  }

  async generateContent(topic = null, style = null, length = 'medium') {
    this.logger.info('Starting content generation pipeline...');
    
    // Step 1: Strategy
    const strategy = await this.agents.strategy.generateContentStrategy(topic);
    this.logger.info(`Strategy generated: ${strategy.topic}`);
    
    // Step 2: Script Writing
    const script = await this.agents.scriptWriter.generateScript(strategy);
    this.logger.info(`Script generated: ${script.title}`);
    
    // Step 3: Thumbnail Design
    const thumbnail = await this.agents.thumbnailDesigner.generateThumbnail(script);
    this.logger.info('Thumbnail generated');
    
    // Step 4: SEO Optimization
    const seoData = await this.agents.seoOptimizer.optimize(script, strategy);
    this.logger.info('SEO optimization complete');
    
    // Step 5: Production Management
    const productionData = await this.agents.production.processContent({
      strategy,
      script,
      thumbnail,
      seo: seoData
    });
    this.logger.info('Production processing complete');
    
    // Step 6: Save to database
    const contentId = await this.db.saveProductionData(productionData);
    this.logger.info(`Content saved with ID: ${contentId}`);
    
    return {
      contentId,
      title: script.title,
      scheduledFor: productionData.scheduledPublishTime
    };
  }

  async start() {
    const initialized = await this.initialize();
    
    if (!initialized) {
      console.log(chalk.red('\n❌ Failed to initialize. Please check your configuration.'));
      process.exit(1);
    }
    
    const PORT = process.env.PORT || 3456;
    this.app.listen(PORT, () => {
      console.log(chalk.green(`\n✅ YouTube Automation Agent running on port ${PORT}`));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(chalk.white('📊 Dashboard: ') + chalk.cyan(`http://localhost:${PORT}`));
      console.log(chalk.white('🔧 API Health: ') + chalk.cyan(`http://localhost:${PORT}/health`));
      console.log(chalk.white('📅 Schedule: ') + chalk.cyan(`http://localhost:${PORT}/schedule`));
      console.log(chalk.white('📈 Analytics: ') + chalk.cyan(`http://localhost:${PORT}/analytics`));
      console.log(chalk.white('🔑 OAuth Callback: ') + chalk.cyan(`${REDIRECT_URI}`));
      console.log(chalk.gray('─'.repeat(50)));
      console.log(chalk.yellow('\n🤖 Automation is active. Content will be generated and posted daily.'));
    });
  }
}

// Start the agent
if (require.main === module) {
  const agent = new YouTubeAutomationAgent();
  agent.start().catch(error => {
    console.error(chalk.red('Fatal error:'), error);
    process.exit(1);
  });
}

module.exports = { YouTubeAutomationAgent };