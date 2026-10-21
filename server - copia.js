require('dotenv').config();
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const http = require('http');
const { Server } = require('socket.io');
const { MercadoPagoConfig, Preference } = require('mercadopago');
const fs = require('fs');
const path = require('path');
const multer = require('multer');

// Asegurar que la carpeta uploads exista físicamente
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Configuración de almacenamiento local para Multer
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, uploadDir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*" }
});

// Aumentar el límite para permitir imágenes pesadas en Base64
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));
app.use(cors());

const PORT = process.env.PORT || 5000;
const MONGO_URI = process.env.MONGO_URI || 'mongodb://localhost:27017/fe_impacto';
const JWT_SECRET = process.env.JWT_SECRET || 'secreto_super_seguro_fe_impacto';

const client = new MercadoPagoConfig({ accessToken: process.env.MP_ACCESS_TOKEN || 'TEST-tu-access-token-aqui' });

const { OpenAI } = require('openai');
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ==========================================
// 1. MODELOS DE MONGOOSE
// ==========================================
const UserSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, enum: ['user', 'admin'], default: 'user' },
    plan: { type: String, default: 'Ninguna Activa' },
    avatar: { type: String, default: '' },
    birthDate: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now, index: true }
});
const User = mongoose.model('User', UserSchema);

const ProductSchema = new mongoose.Schema({
    name: { type: String, required: true },
    category: { type: String, required: true, index: true },
    price: { type: Number, required: true },
    description: { type: String, required: true },
    image: { type: String, default: '' },
    createdAt: { type: Date, default: Date.now, index: true }
});
const Product = mongoose.model('Product', ProductSchema);

const PrayerSchema = new mongoose.Schema({
    category: { type: String, required: true, index: true },
    text: { type: String, required: true },
    authorId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    authorName: { type: String, required: true },
    authorAvatar: { type: String, default: '' },
    count: { type: Number, default: 0 },
    prayedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    messages: [{
        from: String,
        text: String,
        createdAt: { type: Date, default: Date.now }
    }],
    date: { type: String, default: () => new Date().toLocaleDateString() },
    createdAt: { type: Date, default: Date.now, index: true }
});
PrayerSchema.index({ category: 1, createdAt: -1 });
const Prayer = mongoose.model('Prayer', PrayerSchema);

const BusinessSchema = new mongoose.Schema({
    title: { type: String, required: true },
    category: { type: String, required: true, index: true },
    phone: { type: String, required: true },
    desc: { type: String, required: true },
    coverImage: { type: String, default: '' },
    catalogImages: [{ type: String }],
    ownerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    ownerName: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, index: true }
});
const Business = mongoose.model('Business', BusinessSchema);

// Schema para Mensajes Privados
const MessageSchema = new mongoose.Schema({
    sender: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    recipient: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    text: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, index: true }
});
MessageSchema.index({ sender: 1, recipient: 1, createdAt: 1 });
const Message = mongoose.model('Message', MessageSchema);

// Schema para configuraciones globales del templo (Admin config)
const ConfigSchema = new mongoose.Schema({
    key: { type: String, unique: true, required: true },
    value: { type: mongoose.Schema.Types.Mixed, required: true }
});
const Config = mongoose.model('Config', ConfigSchema);

// Schema de CellGroup para incluir mensajes y optimizado con índices
const CellGroupSchema = new mongoose.Schema({
    title: { type: String, required: true },
    category: { type: String, required: true, index: true },
    description: { type: String, required: true },
    leaderName: { type: String, required: true },
    coverImage: { type: String, default: '' },
    membersCount: { type: Number, default: 1 },
    members: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }],
    messages: [{
        senderId: { type: String }, // <--- Cambiado de ObjectId a String para admitir administradores y cualquier ID sin errores
        senderName: String,
        senderAvatar: String,
        text: String,
        createdAt: { type: Date, default: Date.now }
    }],
    createdAt: { type: Date, default: Date.now, index: true }
});
const CellGroup = mongoose.model('CellGroup', CellGroupSchema);

// ==========================================
// 2. MIDDLEWARE DE AUTENTICACIÓN & ROLES
// ==========================================
const verifyToken = async (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader) return res.status(401).json({ error: 'Token no proporcionado' });
    const token = authHeader.split(' ')[1];
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = await User.findById(decoded.id);
        if (!req.user) return res.status(401).json({ error: 'Usuario no encontrado' });
        next();
    } catch (err) {
        res.status(403).json({ error: 'Token inválido o expirado' });
    }
};

const verifyAdmin = (req, res, next) => {
    if (req.user && req.user.role === 'admin') {
        next();
    } else {
        res.status(403).json({ error: 'Acceso denegado. Se requiere rol de Administrador.' });
    }
};


// ==========================================
// 3. RUTAS DE AUTENTICACIÓN Y SESIÓN
// ==========================================
app.post('/api/auth/register', async (req, res) => {
    try {
        const { name, email, password, avatar, birthDate, secretAdminKey } = req.body;
        const existing = await User.findOne({ email });
        if (existing) return res.status(400).json({ error: 'El correo ya está registrado' });

        const hashedPassword = await bcrypt.hash(password, 10);
        
        const totalUsers = await User.countDocuments();
        let role = 'user';
        if (totalUsers === 0 || secretAdminKey === 'PASTOR_FE_IMPACTO_2026') {
            role = 'admin';
        }

        const newUser = new User({ 
            name, 
            email, 
            password: hashedPassword, 
            role, 
            avatar, 
            birthDate: birthDate || '',
            plan: role === 'admin' ? 'Guardián del Templo' : 'Ninguna Activa' 
        });
        await newUser.save();

        const token = jwt.sign({ id: newUser._id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: newUser._id, name: newUser.name, email: newUser.email, role: newUser.role, plan: newUser.plan, avatar: newUser.avatar, birthDate: newUser.birthDate } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        if (!user) return res.status(400).json({ error: 'Credenciales inválidas' });

        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(400).json({ error: 'Credenciales inválidas' });

        const token = jwt.sign({ id: user._id }, JWT_SECRET, { expiresIn: '7d' });
        res.json({ token, user: { id: user._id, name: user.name, email: user.email, role: user.role, plan: user.plan, avatar: user.avatar, birthDate: user.birthDate } });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/auth/me', verifyToken, async (req, res) => {
    try {
        res.json({ 
            user: { 
                id: req.user._id, 
                name: req.user.name, 
                email: req.user.email, 
                role: req.user.role, 
                plan: req.user.plan, 
                avatar: req.user.avatar,
                birthDate: req.user.birthDate 
            } 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/users/avatar', verifyToken, async (req, res) => {
    try {
        const { avatar } = req.body;
        const updatedUser = await User.findByIdAndUpdate(
            req.user._id,
            { avatar: avatar },
            { new: true }
        ).select('-password');

        if (!updatedUser) return res.status(404).json({ error: 'Usuario no encontrado' });

        await Prayer.updateMany(
            { authorId: req.user._id },
            { authorAvatar: avatar }
        );

        res.json({ 
            message: 'Foto actualizada con éxito', 
            user: { 
                id: updatedUser._id, 
                name: updatedUser.name, 
                email: updatedUser.email, 
                role: updatedUser.role, 
                plan: updatedUser.plan, 
                avatar: updatedUser.avatar,
                birthDate: updatedUser.birthDate 
            } 
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/prayers/:id', verifyToken, async (req, res) => {
    try {
        const { text, category } = req.body;
        const prayer = await Prayer.findById(req.params.id);
        
        if (!prayer) return res.status(404).json({ error: 'Petición no encontrada' });

        const isAuthor = prayer.authorId.toString() === req.user._id.toString();
        const isAdmin = req.user.role === 'admin';

        if (!isAuthor && !isAdmin) {
            return res.status(403).json({ error: 'No autorizado para editar esta petición' });
        }

        if (isAuthor && !isAdmin) {
            const createdAt = new Date(prayer.createdAt || prayer.date).getTime();
            const now = new Date().getTime();
            const minutesElapsed = (now - createdAt) / (1000 * 60);

            if (minutesElapsed > 5) {
                return res.status(400).json({ error: 'El tiempo límite de 5 minutos para editar esta petición ha expirado.' });
            }
        }

        prayer.text = text || prayer.text;
        prayer.category = category || prayer.category;
        await prayer.save();

        res.json({ success: true, prayer });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/users/public/:id', verifyToken, async (req, res) => {
    try {
        const user = await User.findById(req.params.id).select('name avatar birthDate');
        if (!user) return res.status(404).json({ error: 'Feligrés no encontrado' });
        res.json(user);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Ruta REST para enviar un mensaje privado
app.post('/api/messages', verifyToken, async (req, res) => {
    try {
        const { recipientId, text } = req.body;
        const senderId = req.user._id;

        if (!recipientId || !text) {
            return res.status(400).json({ error: 'Faltan datos requeridos (recipientId o text)' });
        }

        const cleanSenderId = String(senderId).trim();
        const cleanRecipientId = String(recipientId).trim();

        const newMessage = new Message({
            sender: cleanSenderId,
            recipient: cleanRecipientId,
            text
        });

        await newMessage.save();

        // NOTA: Eliminamos el io.to().emit aquí para evitar que el receptor 
        // reciba un duplicado, ya que el WebSocket (send_private_message) ya se encarga 
        // de propagarlo en tiempo real de forma limpia.

        res.status(201).json({ 
            success: true, 
            message: 'Mensaje enviado con éxito',
            data: newMessage 
        });
    } catch (error) {
        console.error('Error al guardar el mensaje:', error);
        res.status(500).json({ error: 'Error interno del servidor al enviar el mensaje' });
    }
});

// Ruta para obtener los usuarios de la comunidad
app.get('/api/users', verifyToken, async (req, res) => {
    try {
        const currentUserId = req.user._id;
        const users = await User.find({ _id: { $ne: currentUserId } }).select('name email avatar');
        res.json(users);
    } catch (error) {
        console.error('Error al obtener usuarios:', error);
        res.status(500).json({ error: 'Error al cargar la comunidad' });
    }
});

// ==========================================
// 4. RUTAS DE CONFIGURACIÓN GLOBAL (ADMIN)
// ==========================================
app.get('/api/config', async (req, res) => {
    try {
        const configs = await Config.find();
        const configMap = {};
        configs.forEach(c => configMap[c.key] = c.value);
        res.json({
            socialFamilies: configMap['socialFamilies'] || 15,
            financialGoal: configMap['financialGoal'] || 12500000
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.put('/api/config', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { socialFamilies, financialGoal } = req.body;
        if (socialFamilies !== undefined) {
            await Config.findOneAndUpdate({ key: 'socialFamilies' }, { value: Number(socialFamilies) }, { upsert: true });
        }
        if (financialGoal !== undefined) {
            await Config.findOneAndUpdate({ key: 'financialGoal' }, { value: Number(financialGoal) }, { upsert: true });
        }
        res.json({ success: true, message: 'Configuración actualizada en MongoDB' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 5. RUTAS DEL MURO ESPIRITUAL
// ==========================================
app.get('/api/prayers', async (req, res) => {
    try {
        const prayers = await Prayer.find().sort({ createdAt: -1 });
        res.json(prayers);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/prayers', verifyToken, async (req, res) => {
    try {
        const { category, text } = req.body;
        const newPrayer = new Prayer({
            category,
            text,
            authorId: req.user._id,
            authorName: req.user.name,
            authorAvatar: req.user.avatar || ''
        });
        await newPrayer.save();
        res.json(newPrayer);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/prayers/:id', verifyToken, async (req, res) => {
    try {
        const prayer = await Prayer.findById(req.params.id);
        if (!prayer) return res.status(404).json({ error: 'Petición no encontrada' });

        if (req.user.role !== 'admin' && prayer.authorId.toString() !== req.user._id.toString()) {
            return res.status(403).json({ error: 'No autorizado' });
        }

        await Prayer.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/prayers/:id/pray', verifyToken, async (req, res) => {
    try {
        const prayer = await Prayer.findById(req.params.id);
        if (!prayer) return res.status(404).json({ error: 'No encontrada' });

        const userIdStr = req.user._id.toString();
        const hasPrayedIndex = prayer.prayedBy.map(id => id.toString()).indexOf(userIdStr);

        if (hasPrayedIndex !== -1) {
            prayer.prayedBy.splice(hasPrayedIndex, 1);
            prayer.count = Math.max(0, prayer.count - 1);
        } else {
            prayer.prayedBy.push(req.user._id);
            prayer.count += 1;
        }

        await prayer.save();
        res.json(prayer);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/prayers/:id/comment', verifyToken, async (req, res) => {
    try {
        const { text } = req.body;
        const prayer = await Prayer.findById(req.params.id);
        if (!prayer) return res.status(404).json({ error: 'Petición no encontrada' });

        prayer.messages.push({
            from: req.user.name,
            text: text
        });

        await prayer.save();
        res.json(prayer);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 6. RUTAS DEL DIRECTORIO DE EMPRENDEDORES
// ==========================================
app.get('/api/businesses', async (req, res) => {
    try {
        const businesses = await Business.find().sort({ createdAt: -1 });
        res.json(businesses);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/businesses', verifyToken, async (req, res) => {
    try {
        if (req.user.role !== 'admin') {
            const userBusinessCount = await Business.countDocuments({ ownerId: req.user._id });
            if (userBusinessCount >= 2) {
                return res.status(400).json({ error: 'Has alcanzado el límite máximo permitido de 2 emprendimientos.' });
            }
        }

        const { title, category, phone, desc, coverImage, catalogImages } = req.body;
        const newBiz = new Business({
            title,
            category,
            phone,
            desc,
            coverImage: coverImage || '',
            catalogImages: catalogImages || [],
            ownerId: req.user._id,
            ownerName: req.user.name
        });
        await newBiz.save();
        res.json(newBiz);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/businesses/:id', verifyToken, async (req, res) => {
    try {
        const biz = await Business.findById(req.params.id);
        if (!biz) return res.status(404).json({ error: 'Negocio no encontrado' });

        if (req.user.role !== 'admin' && biz.ownerId.toString() !== req.user._id.toString()) {
            return res.status(403).json({ error: 'No autorizado' });
        }

        await Business.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 7. PASARELA DE PAGOS MERCADO PAGO
// ==========================================
app.post('/api/payments/create-preference', verifyToken, async (req, res) => {
    try {
        const { price, planName } = req.body;
        const preference = new Preference(client);
        const result = await preference.create({
            body: {
                items: [{
                    title: `Sostenimiento Templo: ${planName}`,
                    quantity: 1,
                    unit_price: Number(price),
                    currency_id: 'COP'
                }],
                payer: { email: req.user.email, name: req.user.name },
                back_urls: {
                    success: "http://localhost:5000",
                    failure: "http://localhost:5000",
                    pending: "http://localhost:5000"
                },
                auto_return: "approved"
            }
        });
        res.json({ preferenceId: result.id, initPoint: result.init_point });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// 8. WEBSOCKETS (SOCKET.IO) EN TIEMPO REAL
// ==========================================
io.on('connection', (socket) => {
    console.log('⚡ Usuario conectado a WebSockets:', socket.id);

    // Unir al usuario a su propia sala privada basada en su ID limpio
    socket.on('join_room', (userId) => {
        if (userId) {
            const cleanId = String(userId).trim();
            socket.join(cleanId);
            console.log(`👤 Usuario unido a sala privada: [${cleanId}]`);
        }
    });

    // Unirse a la sala de una célula o grupo específico (con prefijo consistente y respaldo limpio)
    socket.on('join_cell_room', (cellId) => {
        if (cellId) {
            const cleanCellId = String(cellId).trim();
            socket.join(`cell_${cleanCellId}`);
            socket.join(cleanCellId); // Respaldo doble para asegurar recepción
            console.log(`👥 Socket [${socket.id}] unido al chat grupal de la célula: [cell_${cleanCellId}] y [${cleanCellId}]`);
        }
    });

    // Escuchar mensajes para la célula y guardarlos en MongoDB
    socket.on('send_cell_message', async (data) => {
        try {
            const targetCellId = data.cellId || data.cell_id;
            const { senderId, text, senderName: clientName, senderAvatar: clientAvatar } = data;
            
            if (!targetCellId || !text) {
                console.log("❌ [SERVIDOR] Faltan datos: targetCellId o text están vacíos");
                return;
            }

            const cleanCellId = String(targetCellId).trim();
            const cleanSenderId = senderId ? String(senderId).trim() : '';

            let finalName = clientName || 'Administrador';
            let finalAvatar = clientAvatar || '';

            // Solo buscar en User.findById si el ID tiene formato válido de MongoDB (24 chars hex)
            if (cleanSenderId && cleanSenderId.match(/^[0-9a-fA-F]{24}$/)) {
                try {
                    const senderUser = await User.findById(cleanSenderId).select('name avatar');
                    if (senderUser) {
                        finalName = senderUser.name || finalName;
                        finalAvatar = senderUser.avatar || finalAvatar;
                    }
                } catch (e) {
                    console.log("Aviso: ID de remitente no encontrado como ObjectId, usando datos de sesión.");
                }
            }

            // Buscar la célula de forma estricta asegurando el ID limpio
            const cell = await CellGroup.findById(cleanCellId);
            if (!cell) {
                console.error(`❌ Error crítico: Célula no encontrada en BD con ID [${cleanCellId}] para guardar mensaje.`);
                return;
            }

            const newMsg = {
                senderId: cleanSenderId || 'admin',
                senderName: finalName,
                senderAvatar: finalAvatar,
                text: text,
                createdAt: new Date()
            };

            if (!cell.messages) cell.messages = [];
            cell.messages.push(newMsg);
            
            // GUARDAR PERMANENTEMENTE EN MONGODB (Evita que se borre al refrescar)
            await cell.save();
            console.log(`💾 Mensaje de célula guardado exitosamente en MongoDB para ID: [${cleanCellId}] por [${finalName}]`);

            // EMITIR EN TIEMPO REAL A AMBAS VARIANTES DE SALA PARA COBERTURA TOTAL
            io.to(`cell_${cleanCellId}`).emit('receive_cell_message', newMsg);
            io.to(cleanCellId).emit('receive_cell_message', newMsg);
            
            console.log(`📤 Mensaje difundido por WebSocket en sala cell_${cleanCellId}:`, newMsg.text);
        } catch (err) {
            console.error('Error crítico al procesar mensaje de célula por WebSocket:', err);
        }
    });

    // Escuchar mensajes privados y propagarlos en tiempo real
    socket.on('send_private_message', async (data) => {
        try {
            const { senderId, recipientId, text, senderName: clientName, senderAvatar: clientAvatar } = data;
            if (!senderId || !recipientId || !text) return;

            const cleanSenderId = String(senderId).trim();
            const cleanRecipientId = String(recipientId).trim();

            // Buscar los datos actuales del remitente (nombre y avatar) en la base de datos
            const senderUser = await User.findById(cleanSenderId).select('name avatar');
            
            console.log(`🔍 Datos del remitente en BD para [${cleanSenderId}]:`, {
                found: !!senderUser,
                name: senderUser ? senderUser.name : 'No encontrado',
                avatar: senderUser ? senderUser.avatar : 'No encontrado'
            });

            // Guardar el mensaje en MongoDB
            const newMessage = new Message({
                sender: cleanSenderId,
                recipient: cleanRecipientId,
                text
            });
            await newMessage.save();

            // Construir el paquete completo priorizando BD, con respaldo del cliente
            const finalName = (senderUser && senderUser.name) ? senderUser.name : (clientName || 'Feligrés');
            const finalAvatar = (senderUser && senderUser.avatar) ? senderUser.avatar : (clientAvatar || '');

            const messagePayload = {
                _id: newMessage._id,
                sender: cleanSenderId,
                recipient: cleanRecipientId,
                text: text,
                createdAt: newMessage.createdAt,
                senderName: finalName,
                senderAvatar: finalAvatar
            };

            console.log(`📤 Emitiendo mensaje de [${messagePayload.senderName}] hacia la sala [${cleanRecipientId}] con avatar: ${messagePayload.senderAvatar ? 'SÍ' : 'NO'}`);

            // Emitir al destinatario usando su ID limpio con nombre y foto incluidos
            io.to(cleanRecipientId).emit('receive_private_message', messagePayload);
        } catch (err) {
            console.error('Error al procesar mensaje por WebSocket:', err);
        }
    });

    

    socket.on('disconnect', () => {
        console.log('🔌 Usuario desconectado:', socket.id);
    });
});
// ==========================================
// 9. INICIALIZACIÓN DE LA BD Y SERVIDOR
// ==========================================
mongoose.connect(MONGO_URI)
    .then(async () => {
        console.log('✅ Conectado exitosamente a MongoDB');
        
        const adminExists = await User.findOne({ role: 'admin' });
        if (!adminExists) {
            const hashedPassword = await bcrypt.hash('admin123', 10);
            await User.create({
                name: 'Pastor Administrador',
                email: 'admin@feimpacto.co',
                password: hashedPassword,
                role: 'admin',
                plan: 'Guardián del Templo'
            });
            console.log('🛡️ Administrador creado en MongoDB: admin@feimpacto.co / admin123');
        }

        server.listen(PORT, () => {
            console.log(`🚀 Servidor y WebSockets corriendo en http://localhost:${PORT}`);
        });
    })
    .catch(err => {
        console.error('❌ Error al conectar a MongoDB:', err.message);
    });

   // Ruta para obtener el historial de chat entre dos usuarios
app.get('/api/messages/:recipientId', verifyToken, async (req, res) => {
    try {
        const currentUserId = String(req.user._id).trim();
        const targetUserId = String(req.params.recipientId).trim();

        const messages = await Message.find({
            $or: [
                { sender: currentUserId, recipient: targetUserId },
                { sender: targetUserId, recipient: currentUserId }
            ]
        }).sort({ createdAt: 1 }); // Ordenados del más antiguo al más reciente (cronológico)

        res.json(messages);
    } catch (error) {
        console.error('Error al obtener el historial de mensajes:', error);
        res.status(500).json({ error: 'Error al cargar los mensajes' });
    }
});

// ==========================================
// RUTAS DE CÉLULAS Y GRUPOS
// ==========================================
app.get('/api/cells', async (req, res) => {
    try {
        const cells = await CellGroup.find().sort({ createdAt: -1 });
        res.json(cells);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// RUTA PARA CREAR CÉLULA (CON SOPORTE DE IMAGEN BASE64)
// ==========================================
app.post('/api/cells', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { title, category, description, leaderName, coverImage } = req.body;

        const newCell = new CellGroup({
            title,
            category,
            description,
            leaderName,
            coverImage: coverImage || '' // Recibe directamente el string Base64 desde el frontend
        });

        await newCell.save();
        res.json(newCell);
    } catch (err) {
        console.error('Error detallado al crear célula en servidor:', err);
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/cells/:id/join', verifyToken, async (req, res) => {
    try {
        const cell = await CellGroup.findById(req.params.id);
        if (!cell) return res.status(404).json({ error: 'Célula no encontrada' });

        const userIdStr = req.user._id.toString();
        const memberIndex = cell.members.map(id => id.toString()).indexOf(userIdStr);

        if (memberIndex !== -1) {
            cell.members.splice(memberIndex, 1);
            cell.membersCount = Math.max(1, cell.membersCount - 1);
        } else {
            cell.members.push(req.user._id);
            cell.membersCount += 1;
        }

        await cell.save();
        res.json(cell);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Obtener mensajes de una célula específica
app.get('/api/cells/:id/messages', verifyToken, async (req, res) => {
    try {
        const cell = await CellGroup.findById(req.params.id);
        if (!cell) return res.status(404).json({ error: 'Célula no encontrada' });
        res.json(cell.messages || []);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ==========================================
// INTEGRACIÓN OPENAI: BÚSQUEDA BÍBLICA EXACTA Y SECUENCIAL (RVR1960)
// ==========================================
app.post('/api/bible/salmo', verifyToken, async (req, res) => {
    try {
        const { query } = req.body; // Ej: "Deuteronomio 10:1-11"

        if (!query || !query.trim()) {
            return res.status(400).json({ error: 'Por favor ingresa una cita o pasaje bíblico.' });
        }

        const promptSystem = `Eres un transcriptor bíblico estricto y sin errores para la plataforma "Fe & Impacto".
Tu tarea es devolver el texto EXACTO de la Reina-Valera 1960 (RVR1960) asegurando que la numeración de los versículos coincida perfectamente con una Biblia impresa tradicional, sin desplazar ni saltar ningún número.

Reglas estrictas:
1. Analiza el rango de la cita solicitada. Cada versículo debe llevar su número real y exacto (si piden hasta el 11, el último objeto debe ser estrictamente el número 11).
2. Responde ÚNICAMENTE en formato JSON válido con la estructura:
{
  "reference": "Cita bíblica exacta (RVR1960)",
  "theme": "Tema principal breve",
  "verses": [
    { "number": 1, "text": "Texto exacto..." },
    { "number": 2, "text": "Texto exacto..." }
  ]
}`;

        const completion = await openai.chat.completions.create({
            model: "gpt-4o-mini",
            messages: [
                { role: "system", content: promptSystem },
                { role: "user", content: `Extrae de forma literal y con la numeración rigurosamente correcta la siguiente cita: ${query}` }
            ],
            response_format: { type: "json_object" },
            temperature: 0
        });

        const salmoData = JSON.parse(completion.choices[0].message.content);

        if (!salmoData.verses || !Array.isArray(salmoData.verses) || salmoData.verses.length === 0) {
            return res.status(404).json({ error: 'No se encontraron versículos para la cita especificada.' });
        }

        // Asegurar por código que los números no se desfasen y salgan limpios
        const formattedText = salmoData.verses.map((v, index) => {
            // Forzamos a que el número impreso sea exactamente el correcto si la IA se llega a descuidar
            const correctNum = v.number || (index + 1);
            return `<span class="text-amber-400 font-bold mr-1">${correctNum}</span> ${v.text.trim()}`;
        }).join(" ");

        res.json({
            reference: salmoData.reference || query,
            theme: salmoData.theme || "Reina-Valera 1960",
            text: formattedText
        });

    } catch (error) {
        console.error('Error al consultar OpenAI para pasaje bíblico:', error);
        res.status(500).json({ error: 'No se pudo obtener el texto bíblico en este momento.' });
    }
});

// ==========================================
// RUTAS DE LA TIENDA Y MERCHANDISING
// ==========================================

// Obtener todos los productos
app.get('/api/products', async (req, res) => {
    try {
        const products = await Product.find().sort({ createdAt: -1 });
        res.json(products);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Crear nuevo producto (Solo Administrador)
app.post('/api/products', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const { name, category, price, description, image } = req.body;
        if (!name || !category || price === undefined) {
            return res.status(400).json({ error: 'Faltan campos obligatorios para crear el producto' });
        }

        const newProduct = new Product({ 
            name, 
            category, 
            price: Number(price), 
            description: description || '', 
            image: image || '' 
        });

        await newProduct.save();
        res.status(201).json(newProduct);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Eliminar producto (Solo Administrador)
app.delete('/api/products/:id', verifyToken, verifyAdmin, async (req, res) => {
    try {
        const deletedProduct = await Product.findByIdAndDelete(req.params.id);
        if (!deletedProduct) {
            return res.status(404).json({ error: 'Producto no encontrado' });
        }
        res.json({ success: true, message: 'Producto eliminado correctamente' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});