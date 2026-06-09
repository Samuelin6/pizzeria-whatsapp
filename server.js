const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const MENU = {
  hawaiana:    { nombre: 'Pizza Hawaiana',    precios: { pequeña: 4.50, mediana: 6.50, grande: 8.50 } },
  pepperoni:   { nombre: 'Pizza Pepperoni',   precios: { pequeña: 4.50, mediana: 6.50, grande: 8.50 } },
  margarita:   { nombre: 'Pizza Margarita',   precios: { pequeña: 4.00, mediana: 6.00, grande: 8.00 } },
  especial:    { nombre: 'Pizza Especial',    precios: { pequeña: 5.50, mediana: 7.50, grande: 9.50 } },
  vegetariana: { nombre: 'Pizza Vegetariana', precios: { pequeña: 4.50, mediana: 6.50, grande: 8.50 } },
  champinones: { nombre: 'Pizza Champiñones', precios: { pequeña: 4.50, mediana: 6.50, grande: 8.50 } },
};
const BEBIDAS = {
  'coca cola': 1.50, coca: 1.50, pepsi: 1.50,
  sprite: 1.50, agua: 1.00, jugo: 1.75,
};

function procesarMensaje(texto) {
  const t = texto.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (/menu|que tienen|que hay|pizzas tienen|carta/.test(t)) return { tipo: 'menu' };
  if (/^(hola|buenos|buenas|hey|buen)/.test(t)) return { tipo: 'saludo' };
  if (/cuanto|precio|cuesta|vale/.test(t)) return { tipo: 'precio', texto };

  let cantidad = 1;
  const mC = t.match(/^(\d+)\s/);
  if (mC) cantidad = parseInt(mC[1]);
  if (/\bdos\b/.test(t)) cantidad = 2;
  if (/\btres\b/.test(t)) cantidad = 3;

  let tamano = 'mediana';
  if (/grande/.test(t)) tamano = 'grande';
  else if (/pequeña|chica/.test(t)) tamano = 'pequeña';

  let items = [];
  for (const [clave, pizza] of Object.entries(MENU)) {
    const c = clave.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (t.includes(clave) || t.includes(c)) {
      items.push({ nombre: `${pizza.nombre} ${tamano}`, cantidad, precio: pizza.precios[tamano] * cantidad });
    }
  }
  for (const [bebida, precio] of Object.entries(BEBIDAS)) {
    if (t.includes(bebida)) items.push({ nombre: bebida.charAt(0).toUpperCase() + bebida.slice(1), cantidad: 1, precio });
  }

  if (!items.length) return { tipo: 'noentendi' };
  return { tipo: 'pedido', items, total: items.reduce((s, i) => s + i.precio, 0), esLlevar: /llevar|recoger/.test(t) };
}

function generarRespuesta(res, textoOriginal) {
  switch (res.tipo) {
    case 'saludo': return '¡Hola! Bienvenido a nuestra pizzería 🍕\n¿Qué deseas ordenar? Escribe *menú* para ver opciones.';
    case 'menu': return '📋 *Nuestro menú:*\n\n🍕 *Pizzas* (pequeña / mediana / grande)\n• Hawaiana $4.50 / $6.50 / $8.50\n• Pepperoni $4.50 / $6.50 / $8.50\n• Margarita $4.00 / $6.00 / $8.00\n• Especial $5.50 / $7.50 / $9.50\n• Vegetariana $4.50 / $6.50 / $8.50\n\n🥤 Coca/Sprite $1.50 · Agua $1.00\n\n¿Qué deseas ordenar?';
    case 'precio': {
      const t = textoOriginal.toLowerCase();
      for (const [k, p] of Object.entries(MENU)) {
        if (t.includes(k)) return `💰 *${p.nombre}*\n• Pequeña $${p.precios.pequeña.toFixed(2)}\n• Mediana $${p.precios.mediana.toFixed(2)}\n• Grande $${p.precios.grande.toFixed(2)}\n\n¿Te la anoto?`;
      }
      return '¿De qué pizza quieres el precio? Escribe *menú* para ver todas.';
    }
    case 'pedido': {
      const lista = res.items.map(i => `• ${i.cantidad}x ${i.nombre} $${i.precio.toFixed(2)}`).join('\n');
      return `✅ *¡Pedido confirmado!* ${res.esLlevar ? '🛍️ Para llevar' : '🛵 A domicilio'}\n\n${lista}\n\n💰 *Total: $${res.total.toFixed(2)}*\n\n⏱ Listo en 20-25 min. ¡Gracias! 😊`;
    }
    default: return 'Disculpa, no entendí 😅\nEscribe *menú* para ver opciones.\nEj: _"Una pizza pepperoni grande"_';
  }
}

let pedidoContador = 0;

const waClient = new Client({
  authStrategy: new LocalAuth(),
  puppeteer: { args: ['--no-sandbox', '--disable-setuid-sandbox'] }
});

waClient.on('qr', async (qr) => {
  console.log('Escanea el QR en http://localhost:3000');
  const qrDataUrl = await QRCode.toDataURL(qr);
  io.emit('qr', qrDataUrl);
});

waClient.on('ready', () => {
  console.log('WhatsApp conectado!');
  io.emit('wa_ready');
});

waClient.on('message', async (msg) => {
  if (msg.isGroupMsg) return;
  const contacto = await msg.getContact();
  const nombre = contacto.pushname || msg.from;
  const resultado = procesarMensaje(msg.body);
  await msg.reply(generarRespuesta(resultado, msg.body));
  if (resultado.tipo === 'pedido') {
    pedidoContador++;
    io.emit('nuevo_pedido', {
      id: pedidoContador,
      items: resultado.items,
      total: resultado.total,
      esLlevar: resultado.esLlevar,
      cliente: nombre,
      telefono: msg.from,
      hora: new Date().toLocaleTimeString('es-SV', { hour: '2-digit', minute: '2-digit' }),
    });
  }
});

io.on('connection', socket => {
  socket.on('pedido_listo', id => io.emit('pedido_listo', id));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor en http://localhost:${PORT}`));
waClient.initialize();
