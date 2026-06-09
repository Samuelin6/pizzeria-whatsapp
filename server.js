require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const twilio = require('twilio');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.urlencoded({ extended: false }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── MENÚ ──────────────────────────────────────────────
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

// ── IA: PROCESADOR DE PEDIDOS ─────────────────────────
function procesarMensaje(texto) {
  const t = texto.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '');

  if (/menu|que tienen|que hay|pizzas tienen|carta/.test(t))
    return { tipo: 'menu' };

  if (/^(hola|buenos|buenas|hey|buen)/.test(t))
    return { tipo: 'saludo' };

  if (/cuanto|precio|cuesta|vale/.test(t))
    return { tipo: 'precio', texto };

  // cantidad
  let cantidad = 1;
  const mC = t.match(/^(\d+)\s/);
  if (mC) cantidad = parseInt(mC[1]);
  if (/\bdos\b/.test(t)) cantidad = 2;
  if (/\btres\b/.test(t)) cantidad = 3;

  // tamaño
  let tamano = 'mediana';
  if (/grande/.test(t)) tamano = 'grande';
  else if (/pequeña|chica/.test(t)) tamano = 'pequeña';

  let items = [];
  for (const [clave, pizza] of Object.entries(MENU)) {
    const claveSinAcento = clave.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    if (t.includes(clave) || t.includes(claveSinAcento)) {
      items.push({
        nombre: `${pizza.nombre} ${tamano}`,
        cantidad,
        precio: pizza.precios[tamano] * cantidad,
      });
    }
  }
  for (const [bebida, precio] of Object.entries(BEBIDAS)) {
    if (t.includes(bebida)) {
      items.push({ nombre: bebida.charAt(0).toUpperCase() + bebida.slice(1), cantidad: 1, precio });
    }
  }

  if (!items.length) return { tipo: 'noentendi' };

  const total = items.reduce((s, i) => s + i.precio, 0);
  const esLlevar = /llevar|recoger/.test(t);
  return { tipo: 'pedido', items, total, esLlevar };
}

function generarRespuesta(res, textoOriginal) {
  switch (res.tipo) {
    case 'saludo':
      return '¡Hola! Bienvenido a nuestra pizzería 🍕\n¿Qué te gustaría ordenar? Escribe *menú* para ver opciones.';
    case 'menu':
      return '📋 *Nuestro menú:*\n\n🍕 *Pizzas* (pequeña / mediana / grande)\n• Hawaiana $4.50 / $6.50 / $8.50\n• Pepperoni $4.50 / $6.50 / $8.50\n• Margarita $4.00 / $6.00 / $8.00\n• Especial $5.50 / $7.50 / $9.50\n• Vegetariana $4.50 / $6.50 / $8.50\n\n🥤 Coca/Sprite $1.50 · Agua $1.00\n\n¿Qué deseas ordenar?';
    case 'precio': {
      const t = textoOriginal.toLowerCase();
      for (const [k, p] of Object.entries(MENU)) {
        if (t.includes(k)) return `💰 *${p.nombre}*\n• Pequeña $${p.precios.pequeña.toFixed(2)}\n• Mediana $${p.precios.mediana.toFixed(2)}\n• Grande $${p.precios.grande.toFixed(2)}\n\n¿Te la anoto?`;
      }
      return '¿De qué pizza quieres el precio? Escribe *menú* para ver todas.';
    }
    case 'pedido': {
      const lista = res.items.map(i => `• ${i.cantidad}x ${i.nombre} $${i.precio.toFixed(2)}`).join('\n');
      const entrega = res.esLlevar ? '🛍️ Para llevar' : '🛵 A domicilio';
      return `✅ *¡Pedido confirmado!* ${entrega}\n\n${lista}\n\n💰 *Total: $${res.total.toFixed(2)}*\n\n⏱ Listo en 20-25 min. ¡Gracias! 😊`;
    }
    default:
      return 'Disculpa, no entendí tu pedido 😅\nEscribe *menú* para ver opciones o intenta de nuevo.\nEj: _"Una pizza pepperoni grande"_';
  }
}

// ── WEBHOOK DE TWILIO ─────────────────────────────────
let pedidoContador = 0;

app.post('/webhook', (req, res) => {
  const mensaje  = req.body.Body  || '';
  const telefono = req.body.From  || 'Desconocido';
  const nombre   = req.body.ProfileName || telefono;

  console.log(`[WhatsApp] ${nombre}: ${mensaje}`);

  const resultado  = procesarMensaje(mensaje);
  const respuesta  = generarRespuesta(resultado, mensaje);

  // Emitir a la pantalla en tiempo real
  if (resultado.tipo === 'pedido') {
    pedidoContador++;
    io.emit('nuevo_pedido', {
      id:       pedidoContador,
      items:    resultado.items,
      total:    resultado.total,
      esLlevar: resultado.esLlevar,
      cliente:  nombre,
      telefono,
      hora:     new Date().toLocaleTimeString('es-SV', { hour: '2-digit', minute: '2-digit' }),
    });
  }

  // Responder por WhatsApp via Twilio
  const twiml = new twilio.twiml.MessagingResponse();
  twiml.message(respuesta);
  res.type('text/xml').send(twiml.toString());
});

// ── SOCKET: pantalla marca pedido listo ──────────────
io.on('connection', socket => {
  console.log('Pantalla conectada');
  socket.on('pedido_listo', id => io.emit('pedido_listo', id));
});

// ── SERVIDOR ──────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor corriendo en puerto ${PORT}`));
