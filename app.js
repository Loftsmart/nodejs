const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Database PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Email transporter configuration
const emailTransporter = nodemailer.createTransporter({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

// Middleware
app.use(cors({
  origin: [
    'https://claude.ai',
    'http://localhost:3000',
    'https://loft-73.myshopify.com'
  ],
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.raw({ type: 'application/json', limit: '10mb' }));

// Shopify webhook verification middleware
const verifyShopifyWebhook = (req, res, next) => {
  const hmac = req.get('X-Shopify-Hmac-Sha256');
  const body = req.body;
  const hash = crypto.createHmac('sha256', process.env.SHOPIFY_WEBHOOK_SECRET || 'your-webhook-secret')
                     .update(body, 'utf8')
                     .digest('base64');

  if (hash !== hmac) {
    console.log('Webhook verification failed');
    return res.status(401).send('Unauthorized');
  }
  
  req.body = JSON.parse(body);
  next();
};

// Initialize database tables
async function initDatabase() {
  try {
    // Back-in-stock requests table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS back_in_stock_requests (
        id SERIAL PRIMARY KEY,
        shop_domain VARCHAR(255) NOT NULL,
        product_id BIGINT NOT NULL,
        variant_id BIGINT NOT NULL,
        sku VARCHAR(255),
        product_name VARCHAR(255),
        variant_title VARCHAR(255),
        customer_email VARCHAR(255) NOT NULL,
        customer_name VARCHAR(255),
        status VARCHAR(50) DEFAULT 'pending',
        created_at TIMESTAMP DEFAULT NOW(),
        notified_at TIMESTAMP NULL,
        price DECIMAL(10,2),
        currency VARCHAR(3) DEFAULT 'EUR'
      );
    `);

    // Webhook logs table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS webhook_logs (
        id SERIAL PRIMARY KEY,
        webhook_type VARCHAR(100) NOT NULL,
        shop_domain VARCHAR(255),
        payload JSONB,
        processed BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Email notifications table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS email_notifications (
        id SERIAL PRIMARY KEY,
        request_id INTEGER REFERENCES back_in_stock_requests(id),
        email VARCHAR(255) NOT NULL,
        subject VARCHAR(500),
        status VARCHAR(50) DEFAULT 'pending',
        sent_at TIMESTAMP NULL,
        error_message TEXT,
        created_at TIMESTAMP DEFAULT NOW()
      );
    `);

    console.log('✅ Database initialized successfully');
  } catch (error) {
    console.error('❌ Database initialization error:', error);
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  res.json({
    status: 'online',
    timestamp: new Date().toISOString(),
    service: 'LOFT.73 Back-In-Stock Server',
    version: '1.0.0',
    endpoints: {
      webhooks: {
        'variants-in-stock': '/webhooks/variants-in-stock',
        'inventory-update': '/webhooks/inventory-update',
        'products-update': '/webhooks/products-update'
      },
      api: {
        'requests': '/api/requests',
        'analytics': '/api/analytics',
        'notify': '/api/notify'
      }
    }
  });
});

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    message: '🚀 LOFT.73 Back-In-Stock Server',
    status: 'Active',
    endpoints: [
      'GET /health - Health check',
      'POST /webhooks/variants-in-stock - Shopify variant back in stock',
      'POST /webhooks/inventory-update - Shopify inventory updates',
      'POST /webhooks/products-update - Shopify product updates',
      'GET /api/requests - Get back-in-stock requests',
      'POST /api/requests - Create new request',
      'POST /api/notify/:id - Send notification',
      'GET /api/analytics - Get analytics data'
    ]
  });
});

// Shopify Webhook: Variant back in stock
app.post('/webhooks/variants-in-stock', verifyShopifyWebhook, async (req, res) => {
  try {
    const variant = req.body;
    
    console.log(`📦 Variant back in stock: ${variant.sku} (ID: ${variant.id})`);

    // Log webhook
    await pool.query(
      'INSERT INTO webhook_logs (webhook_type, shop_domain, payload) VALUES ($1, $2, $3)',
      ['variants-in-stock', req.get('X-Shopify-Shop-Domain'), JSON.stringify(variant)]
    );

    // Find pending requests for this variant
    const pendingRequests = await pool.query(
      'SELECT * FROM back_in_stock_requests WHERE variant_id = $1 AND status = $2',
      [variant.id, 'pending']
    );

    if (pendingRequests.rows.length > 0) {
      console.log(`📧 Found ${pendingRequests.rows.length} pending requests for variant ${variant.id}`);
      
      // Send notifications
      for (const request of pendingRequests.rows) {
        await sendBackInStockNotification(request, variant);
      }
    }

    res.status(200).json({ 
      success: true, 
      processed: pendingRequests.rows.length,
      variant_id: variant.id 
    });

  } catch (error) {
    console.error('❌ Webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Shopify Webhook: Inventory level update
app.post('/webhooks/inventory-update', verifyShopifyWebhook, async (req, res) => {
  try {
    const inventory = req.body;
    
    console.log(`📊 Inventory update: ${inventory.inventory_item_id} - Available: ${inventory.available}`);

    // Log webhook
    await pool.query(
      'INSERT INTO webhook_logs (webhook_type, shop_domain, payload) VALUES ($1, $2, $3)',
      ['inventory-update', req.get('X-Shopify-Shop-Domain'), JSON.stringify(inventory)]
    );

    // If inventory becomes available, trigger notifications
    if (inventory.available > 0) {
      console.log(`✅ Inventory available: ${inventory.available} units`);
    }

    res.status(200).json({ 
      success: true,
      inventory_item_id: inventory.inventory_item_id,
      available: inventory.available
    });

  } catch (error) {
    console.error('❌ Inventory webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Shopify Webhook: Product update
app.post('/webhooks/products-update', verifyShopifyWebhook, async (req, res) => {
  try {
    const product = req.body;
    
    console.log(`🛍️ Product updated: ${product.title} (ID: ${product.id})`);

    // Log webhook
    await pool.query(
      'INSERT INTO webhook_logs (webhook_type, shop_domain, payload) VALUES ($1, $2, $3)',
      ['products-update', req.get('X-Shopify-Shop-Domain'), JSON.stringify(product)]
    );

    // Check variants for availability
    for (const variant of product.variants || []) {
      if (variant.inventory_quantity > 0) {
        console.log(`📦 Variant ${variant.sku} now has ${variant.inventory_quantity} units`);
        
        // Find pending requests
        const pendingRequests = await pool.query(
          'SELECT * FROM back_in_stock_requests WHERE variant_id = $1 AND status = $2',
          [variant.id, 'pending']
        );

        // Send notifications
        for (const request of pendingRequests.rows) {
          await sendBackInStockNotification(request, variant);
        }
      }
    }

    res.status(200).json({ 
      success: true,
      product_id: product.id,
      variants_checked: product.variants?.length || 0
    });

  } catch (error) {
    console.error('❌ Product webhook error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API: Get all back-in-stock requests
app.get('/api/requests', async (req, res) => {
  try {
    const { status, shop_domain, limit = 100 } = req.query;
    
    let query = 'SELECT * FROM back_in_stock_requests';
    const params = [];
    const conditions = [];

    if (status) {
      conditions.push(`status = $${params.length + 1}`);
      params.push(status);
    }

    if (shop_domain) {
      conditions.push(`shop_domain = $${params.length + 1}`);
      params.push(shop_domain);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ` ORDER BY created_at DESC LIMIT $${params.length + 1}`;
    params.push(limit);

    const result = await pool.query(query, params);

    res.json({
      success: true,
      requests: result.rows,
      total: result.rows.length
    });

  } catch (error) {
    console.error('❌ API requests error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API: Create new back-in-stock request
app.post('/api/requests', async (req, res) => {
  try {
    const {
      shop_domain,
      product_id,
      variant_id,
      sku,
      product_name,
      variant_title,
      customer_email,
      customer_name,
      price,
      currency = 'EUR'
    } = req.body;

    // Check if request already exists
    const existing = await pool.query(
      'SELECT id FROM back_in_stock_requests WHERE variant_id = $1 AND customer_email = $2 AND status = $3',
      [variant_id, customer_email, 'pending']
    );

    if (existing.rows.length > 0) {
      return res.status(400).json({ 
        error: 'Request already exists for this customer and variant' 
      });
    }

    // Create new request
    const result = await pool.query(`
      INSERT INTO back_in_stock_requests 
      (shop_domain, product_id, variant_id, sku, product_name, variant_title, customer_email, customer_name, price, currency)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING *
    `, [shop_domain, product_id, variant_id, sku, product_name, variant_title, customer_email, customer_name, price, currency]);

    console.log(`✅ New back-in-stock request created: ${customer_email} for ${sku}`);

    res.status(201).json({
      success: true,
      request: result.rows[0]
    });

  } catch (error) {
    console.error('❌ Create request error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API: Send notification manually
app.post('/api/notify/:id', async (req, res) => {
  try {
    const requestId = req.params.id;
    
    const request = await pool.query(
      'SELECT * FROM back_in_stock_requests WHERE id = $1',
      [requestId]
    );

    if (request.rows.length === 0) {
      return res.status(404).json({ error: 'Request not found' });
    }

    const requestData = request.rows[0];
    await sendBackInStockNotification(requestData);

    res.json({
      success: true,
      message: 'Notification sent successfully'
    });

  } catch (error) {
    console.error('❌ Manual notification error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// API: Get analytics data
app.get('/api/analytics', async (req, res) => {
  try {
    // Total requests
    const totalRequests = await pool.query(
      'SELECT COUNT(*) as count FROM back_in_stock_requests'
    );

    // Requests by status
    const statusBreakdown = await pool.query(`
      SELECT status, COUNT(*) as count 
      FROM back_in_stock_requests 
      GROUP BY status
    `);

    // Top requested products
    const topProducts = await pool.query(`
      SELECT product_name, COUNT(*) as requests, SUM(price) as potential_revenue
      FROM back_in_stock_requests 
      WHERE status = 'pending'
      GROUP BY product_name 
      ORDER BY requests DESC 
      LIMIT 10
    `);

    // Recent activity (last 30 days)
    const recentActivity = await pool.query(`
      SELECT DATE(created_at) as date, COUNT(*) as requests
      FROM back_in_stock_requests 
      WHERE created_at >= NOW() - INTERVAL '30 days'
      GROUP BY DATE(created_at)
      ORDER BY date
    `);

    res.json({
      success: true,
      analytics: {
        total_requests: parseInt(totalRequests.rows[0].count),
        status_breakdown: statusBreakdown.rows,
        top_products: topProducts.rows,
        recent_activity: recentActivity.rows
      }
    });

  } catch (error) {
    console.error('❌ Analytics error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Function to send back-in-stock email notification
async function sendBackInStockNotification(request, variant = null) {
  try {
    const emailHtml = `
      <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
        <div style="background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); padding: 20px; text-align: center;">
          <h1 style="color: white; margin: 0;">LOFT.73</h1>
          <p style="color: white; margin: 5px 0;">Il tuo prodotto è tornato disponibile!</p>
        </div>
        
        <div style="padding: 30px; background: #f9f9f9;">
          <h2 style="color: #333;">Ciao ${request.customer_name || 'Cliente'}! 👋</h2>
          
          <p style="font-size: 16px; line-height: 1.6; color: #555;">
            Ottima notizia! Il prodotto che stavi aspettando è di nuovo disponibile nel nostro store.
          </p>
          
          <div style="background: white; padding: 20px; border-radius: 8px; margin: 20px 0; border-left: 4px solid #667eea;">
            <h3 style="margin: 0 0 10px 0; color: #333;">${request.product_name}</h3>
            <p style="margin: 5px 0; color: #666;"><strong>Codice:</strong> ${request.sku}</p>
            <p style="margin: 5px 0; color: #666;"><strong>Variante:</strong> ${request.variant_title}</p>
            <p style="margin: 5px 0; color: #667eea; font-size: 18px; font-weight: bold;">€${request.price}</p>
          </div>
          
          <div style="text-align: center; margin: 30px 0;">
            <a href="https://loft-73.myshopify.com/products/${request.sku}" 
               style="background: #667eea; color: white; padding: 15px 30px; text-decoration: none; border-radius: 5px; font-weight: bold; display: inline-block;">
              🛍️ ACQUISTA ORA
            </a>
          </div>
          
          <p style="font-size: 14px; color: #888; text-align: center;">
            Affrettati! Le quantità potrebbero essere limitate.
          </p>
        </div>
        
        <div style="background: #333; color: white; padding: 20px; text-align: center; font-size: 12px;">
          <p>LOFT.73 - Abbigliamento di qualità</p>
          <p>Hai ricevuto questa email perché ti sei iscritto alle notifiche back-in-stock.</p>
        </div>
      </div>
    `;

    const mailOptions = {
      from: process.env.EMAIL_USER || 'noreply@loft73.com',
      to: request.customer_email,
      subject: `🎉 ${request.product_name} è di nuovo disponibile! - LOFT.73`,
      html: emailHtml
    };

    await emailTransporter.sendMail(mailOptions);

    // Update request status
    await pool.query(
      'UPDATE back_in_stock_requests SET status = $1, notified_at = NOW() WHERE id = $2',
      ['notified', request.id]
    );

    // Log email notification
    await pool.query(
      'INSERT INTO email_notifications (request_id, email, subject, status, sent_at) VALUES ($1, $2, $3, $4, NOW())',
      [request.id, request.customer_email, mailOptions.subject, 'sent']
    );

    console.log(`✅ Email sent to ${request.customer_email} for ${request.sku}`);

  } catch (error) {
    console.error(`❌ Email sending failed for ${request.customer_email}:`, error);
    
    // Log failed email
    await pool.query(
      'INSERT INTO email_notifications (request_id, email, subject, status, error_message) VALUES ($1, $2, $3, $4, $5)',
      [request.id, request.customer_email, 'Back-in-stock notification', 'failed', error.message]
    );
  }
}

// Error handling middleware
app.use((error, req, res, next) => {
  console.error('❌ Server error:', error);
  res.status(500).json({ 
    error: 'Internal server error',
    message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong'
  });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Endpoint not found',
    available_endpoints: [
      'GET /',
      'GET /health',
      'POST /webhooks/variants-in-stock',
      'POST /webhooks/inventory-update', 
      'POST /webhooks/products-update',
      'GET /api/requests',
      'POST /api/requests',
      'POST /api/notify/:id',
      'GET /api/analytics'
    ]
  });
});

// Start server
app.listen(PORT, async () => {
  console.log('🚀 LOFT.73 Back-In-Stock Server Started');
  console.log(`📡 Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || 'development'}`);
  
  // Initialize database
  await initDatabase();
  
  console.log('✅ Server ready to receive webhooks and API calls');
});

module.exports = app;
