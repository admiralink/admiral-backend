const express = require('express');
const axios = require('axios');
const cors = require('cors');
const https = require('https');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// Ignore self-signed SSL certs from local Omada Controller hardware
const httpsAgent = new https.Agent({ rejectUnauthorized: false });

// Helper to sanitize MAC addresses (Omada expects XX-XX-XX-XX-XX-XX or XXXXXXXXXXXX depending on version)
const formatMac = (mac) => mac ? mac.replace(/[^a-zA-Z0-9]/g, '').toUpperCase() : '';

app.post('/api/verify-and-connect', async (req, res) => {
    const { reference, clientMac, apMac, durationMinutes } = req.body;

    if (!reference) {
        return res.status(400).json({ success: false, message: 'Transaction reference is required.' });
    }

    try {
        // STEP 1: Verify Payment with Paystack
        const paystackRes = await axios.get(
            `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
            {
                headers: { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` }
            }
        );

        const transaction = paystackRes.data.data;
        if (!transaction || transaction.status !== 'success') {
            return res.status(400).json({ success: false, message: 'Paystack payment verification failed or pending.' });
        }

        // STEP 2: Authenticate with TP-Link Omada Controller
        const loginRes = await axios.post(
            `${process.env.OMADA_URL}/${process.env.OMADA_CONTROLLER_ID}/api/v2/login`,
            {
                username: process.env.OMADA_USERNAME,
                password: process.env.OMADA_PASSWORD
            },
            { httpsAgent }
        );

        const cookies = loginRes.headers['set-cookie'];
        const csrfToken = loginRes.data.result.token;

        const omadaHeaders = {
            'Content-Type': 'application/json',
            'Omada-CSRFToken': csrfToken,
            'Cookie': cookies ? cookies.join('; ') : ''
        };

        // STEP 3: Create Voucher in Omada Controller
        // Convert duration to minutes (or hours depending on your Omada firmware version)
        const voucherPayload = {
            name: `Paystack_${reference.substring(0, 8)}`,
            amount: 1, // Number of voucher codes to generate
            duration: parseInt(durationMinutes, 10) || 1320, // Default 22 hrs
            amountType: 0, // 0 = Single device access
            trafficLimit: 0, // 0 = Unlimited
            upRateEnable: 0,
            downRateEnable: 0
        };

        const site = process.env.OMADA_SITE_NAME || 'default';
        const voucherRes = await axios.post(
            `${process.env.OMADA_URL}/${process.env.OMADA_CONTROLLER_ID}/api/v2/sites/${site}/vouchers`,
            voucherPayload,
            { headers: omadaHeaders, httpsAgent }
        );

        // Omada returns an array of generated voucher objects or batch ID
        const generatedVouchers = voucherRes.data.result;
        let createdVoucherCode = '';

        if (Array.isArray(generatedVouchers) && generatedVouchers.length > 0) {
            createdVoucherCode = generatedVouchers[0].code;
        } else if (generatedVouchers && generatedVouchers.code) {
            createdVoucherCode = generatedVouchers.code;
        } else {
            // Fetch the latest generated batch if the response returns a batch object
            const batchId = generatedVouchers.id || generatedVouchers;
            const batchRes = await axios.get(
                `${process.env.OMADA_URL}/${process.env.OMADA_CONTROLLER_ID}/api/v2/sites/${site}/vouchers/${batchId}`,
                { headers: omadaHeaders, httpsAgent }
            );
            createdVoucherCode = batchRes.data.result[0].code;
        }

        // STEP 4: Return success to Frontend Modal
        return res.json({
            success: true,
            message: 'Voucher generated successfully.',
            voucherCode: createdVoucherCode
        });

    } catch (error) {
        console.error('API Error:', error.response ? error.response.data : error.message);
        return res.status(500).json({
            success: false,
            message: 'Server error during verification and authorization.',
            details: error.response ? error.response.data : error.message
        });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Admiral Hotspot Backend running on port ${PORT}`);
});