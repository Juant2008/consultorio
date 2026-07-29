require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const { default: makeWASocket, DisconnectReason, BufferJSON, initAuthCreds } = require('@whiskeysockets/baileys');
const cors = require('cors');
const morgan = require('morgan');
const pino = require('pino');
const qrcode = require('qrcode-terminal');
const https = require('https');


const app = express();
app.use(cors());
app.use(morgan('short'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Pool MySQL
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 5,
  charset: 'utf8mb4',
});

// ============================================================
// SISTEMA DE SILENCIO / HANDOFF HUMANO
// ============================================================
const silenced = new Map();
const SILENCE_DURATION_MS = 60 * 60 * 1000;

function isSilenced(telefono) {
  if (!silenced.has(telefono)) return false;
  const entry = silenced.get(telefono);
  const elapsed = Date.now() - entry.silencedAt.getTime();
  if (elapsed >= SILENCE_DURATION_MS) {
    silenced.delete(telefono);
    console.log(`🔊 Bot reactivado automáticamente para ${telefono}`);
    return false;
  }
  return true;
}

function silencePatient(telefonoPaciente, silencedBy) {
  silenced.set(telefonoPaciente, { silencedAt: new Date(), silencedBy });
  console.log(`🔇 Bot silenciado para ${telefonoPaciente} por ${silencedBy}`);
}

function releasePatient(telefonoPaciente) {
  silenced.delete(telefonoPaciente);
  console.log(`🔊 Bot reactivado manualmente para ${telefonoPaciente}`);
}

function getTimeUntilRelease(telefono) {
  if (!silenced.has(telefono)) return 0;
  const entry = silenced.get(telefono);
  return Math.max(0, SILENCE_DURATION_MS - (Date.now() - entry.silencedAt.getTime()));
}

// Sesiones de conversación
const sessions = new Map();

const MENU = `╔══════════════════════════╗
║  PORTAL DE ESPECIALIDADES  ║
╚══════════════════════════╝

Hola, soy el asistente virtual. Elige una opción:

1  Consultar Mis Citas
2  Mis Tratamientos Activos
3  Agendar Nueva Cita
4  Mis Recetas Electrónicas
5  Mi Historial Clínico
6  Hablar con el Médico
7  Datos del Consultorio

Responde solo el número de la opción deseada.`;

// ============================================================
// AUTH STATE EN MYSQL (para que persista en Render)
// ============================================================
async function useMySQLAuthState() {
  const [rows] = await pool.query(
    "SELECT valor FROM configuracion WHERE clave = 'baileys_auth_state'"
  );

  let creds;
  const keyData = {};

  if (rows.length > 0 && rows[0].valor) {
    try {
      const saved = JSON.parse(rows[0].valor, BufferJSON.reviver);
      creds = saved.creds;
      if (saved.keys) Object.assign(keyData, saved.keys);
      console.log('✅ Sesión WhatsApp cargada desde MySQL');
    } catch (e) {
      console.log('⚠️ Error cargando sesión, creando nueva:', e.message);
      creds = initAuthCreds();
    }
  } else {
    console.log('🆕 No hay sesión guardada. Se generará QR.');
    creds = initAuthCreds();
  }

  const keysStore = {
    get: async (type, ids) => {
      const data = keyData[type];
      if (!data) return {};
      const result = {};
      for (const id of ids) {
        if (data[id]) result[id] = data[id];
      }
      return result;
    },
    set: async (data) => {
      for (const type in data) {
        if (!keyData[type]) keyData[type] = {};
        Object.assign(keyData[type], data[type]);
      }
    },
  };

  const saveState = async () => {
    try {
      const data = JSON.stringify({ creds, keys: keyData }, BufferJSON.replacer);
      await pool.query(
        "REPLACE INTO configuracion (clave, valor) VALUES ('baileys_auth_state', ?)",
        [data]
      );
    } catch (e) {
      console.error('Error guardando sesión:', e.message);
    }
  };

  return {
    state: { creds, keys: keysStore },
    saveState,
  };
}

// Variable global para el socket de WhatsApp
let sock = null;
let ultimoQR = null;
let conexionEstado = 'desconectado';

// ============================================================
// INICIAR WHATSAPP SOCKET
// ============================================================
async function iniciarWhatsApp() {
  const auth = await useMySQLAuthState();

  sock = makeWASocket({
    printQRInTerminal: false,
    auth: auth.state,
    logger: pino({ level: process.env.LOG_LEVEL || 'silent' }),
    browser: ['Portal de Especialidades', 'Chrome', '1.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false,
  });

  // QR Code
  sock.ev.on('creds.update', async () => {
    await auth.saveState();
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      ultimoQR = qr;
      qrcode.generate(qr, { small: true });
      console.log('📱 ESCANEA EL QR CON TU WHATSAPP');
      conexionEstado = 'qr_pendiente';
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp CONECTADO');
      console.log(`📱 Número: ${sock.user?.id?.split(':')[0] || 'desconocido'}`);
      conexionEstado = 'conectado';
      ultimoQR = null;
      await auth.saveState();
    }

    if (connection === 'close') {
      const reason = lastDisconnect?.error?.output?.statusCode;
      conexionEstado = `desconectado (${reason})`;
      console.log(`❌ Desconectado: ${DisconnectReason[reason] || reason}`);

      if (reason === DisconnectReason.loggedOut) {
        await pool.query("DELETE FROM configuracion WHERE clave = 'baileys_auth_state'");
        console.log('🗑️ Sesión eliminada. Generando nuevo QR...');
        setTimeout(iniciarWhatsApp, 2000);
      } else {
        // Reconectar
        console.log('🔄 Reconectando en 5 segundos...');
        setTimeout(iniciarWhatsApp, 5000);
      }
    }
  });

  // Mensajes entrantes
  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    console.log(`📨 messages.upsert type=${type} count=${messages.length}`);

    for (const msg of messages) {
      try {
        const remoteJid = msg.key?.remoteJid || '';
        if (!remoteJid.endsWith('@s.whatsapp.net')) continue;
        if (msg.key?.fromMe) continue;
        if (!msg.message) continue;

        const telefono = remoteJid.replace('@s.whatsapp.net', '');
        const pushName = msg.pushName || '';

        // Extraer texto de cualquier formato de mensaje
        let texto = '';
        const msgType = Object.keys(msg.message)[0];
        if (msgType === 'conversation') {
          texto = msg.message.conversation || '';
        } else if (msgType === 'extendedTextMessage') {
          texto = msg.message.extendedTextMessage?.text || '';
        } else if (msg.message?.conversation) {
          texto = msg.message.conversation;
        } else if (msg.message?.extendedTextMessage?.text) {
          texto = msg.message.extendedTextMessage.text;
        }

        if (!texto) continue;

        console.log(`📩 WA de ${pushName || telefono}: "${texto.substring(0, 100)}"`);

        // Procesar el mensaje
        await procesarMensaje(telefono, texto, msg.key.id || '');
      } catch (err) {
        console.error('Error procesando mensaje individual:', err.message);
      }
    }
  });
}

// ============================================================
// ENVIAR WHATSAPP
// ============================================================
async function enviarWhatsApp(telefono, mensaje) {
  if (!sock) {
    console.error('WhatsApp no conectado');
    return false;
  }
  try {
    const jid = telefono.includes('@s.whatsapp.net') ? telefono : `${telefono}@s.whatsapp.net`;
    await sock.sendMessage(jid, { text: mensaje });
    return true;
  } catch (err) {
    console.error(`Error enviando WA a ${telefono}:`, err.message);
    return false;
  }
}

// ============================================================
// FLUJO PRINCIPAL
// ============================================================
async function procesarMensaje(telefono, texto, msgId, rawMsg) {
  texto = texto.trim();

  // Verificar silencio
  if (isSilenced(telefono)) {
    const remaining = getTimeUntilRelease(telefono);
    console.log(`🔇 Silenciado para ${telefono} - reanuda en ${Math.ceil(remaining / 60000)} min`);
    return;
  }

  let session = sessions.get(telefono);

  if (!session) {
    sessions.set(telefono, { state: 'MENU', data: {} });
    await enviarWhatsApp(telefono, MENU);
    return;
  }

  const state = session.state;

  switch (state) {

    case 'MENU':
      switch (texto) {
        case '1':
          session.state = 'CITAS_CEDULA';
          session.data = {};
          await enviarWhatsApp(telefono, 'CONSULTAR CITAS\n\nIngresa tu cédula (solo números, sin letras ni guiones):');
          break;
        case '2':
          session.state = 'TRATAMIENTOS_CEDULA';
          session.data = {};
          await enviarWhatsApp(telefono, 'MIS TRATAMIENTOS\n\nIngresa tu cédula para consultar tus tratamientos activos:');
          break;
        case '3':
          session.state = 'AGENDAR_PASO1';
          session.data = {};
          await enviarWhatsApp(telefono, 'AGENDAR NUEVA CITA\n\nVamos a agendar tu cita paso a paso.\n\nPrimero, ingresa tu cédula (solo números):');
          break;
        case '4':
          session.state = 'RECETAS_CEDULA';
          session.data = {};
          await enviarWhatsApp(telefono, 'MIS RECETAS\n\nIngresa tu cédula para ver tus recetas electrónicas:');
          break;
        case '5':
          session.state = 'HISTORIAL_CEDULA';
          session.data = {};
          await enviarWhatsApp(telefono, 'HISTORIAL CLÍNICO\n\nIngresa tu cédula para consultar tu historial:');
          break;
        case '6':
          session.state = 'MENSAJE_MEDICO';
          session.data = {};
          await enviarWhatsApp(telefono, 'HABLAR CON EL MÉDICO\n\nEscribe el mensaje que deseas enviarle al doctor. Incluye tu nombre y el motivo de tu contacto.\n\n(Escribe "cancelar" para volver al menú principal)');
          break;
        case '7':
          const centros = await listarCentros();
          let msgCentros = 'CENTROS MÉDICOS\n\n';
          for (const c of centros) {
            msgCentros += `${c.nombre}\n`;
            msgCentros += `  ${c.direccion || ''}\n`;
            msgCentros += `  ${c.telefono || ''}\n`;
            msgCentros += `  ${c.horario_atencion || ''}\n\n`;
          }
          msgCentros += '0  Volver al menú principal';
          await enviarWhatsApp(telefono, msgCentros);
          session.state = 'MENU';
          break;
        case '0':
          await enviarWhatsApp(telefono, MENU);
          break;
        default:
          await enviarWhatsApp(telefono, `Opción no válida. Responde solo el número:

1  Consultar Mis Citas
2  Mis Tratamientos Activos
3  Agendar Nueva Cita
4  Mis Recetas Electrónicas
5  Mi Historial Clínico
6  Hablar con el Médico
7  Datos del Consultorio`);
      }
      break;

    case 'CITAS_CEDULA':
      session.data.cedula = texto;
      const citas = await buscarCitasPorCedula(texto);
      if (citas.length === 0) {
        await enviarWhatsApp(telefono, `No se encontraron citas para la cédula ${texto}.

1  Intentar de nuevo
2  Agendar nueva cita
0  Volver al menú principal`);
        session.state = 'CITAS_OPCIONES';
      } else {
        let msg = `TUS CITAS (${citas.length})\n\n`;
        for (const c of citas) {
          const estados = { 'Pendiente': 'PENDIENTE', 'Confirmada': 'CONFIRMADA', 'Completada': 'COMPLETADA', 'Cancelada': 'CANCELADA' };
          msg += `${new Date(c.fecha).toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}\n`;
          msg += `Hora: ${c.hora?.substring(0, 5)}\n`;
          if (c.doctor_nombre) msg += `Dr. ${c.doctor_nombre}\n`;
          msg += `${c.centro_nombre}\n`;
          if (c.motivo) msg += `${c.motivo.substring(0, 80)}\n`;
          msg += `Estado: ${estados[c.estado] || c.estado}\n\n`;
        }
        msg += '0  Volver al menú principal';
        await enviarWhatsApp(telefono, msg);
        session.state = 'MENU';
      }
      break;

    case 'CITAS_OPCIONES':
      if (texto === '1') {
        session.state = 'CITAS_CEDULA';
        await enviarWhatsApp(telefono, 'Ingresa tu cédula nuevamente:');
      } else if (texto === '2') {
        session.state = 'AGENDAR_PASO1';
        session.data = {};
        await enviarWhatsApp(telefono, 'AGENDAR NUEVA CITA\n\nIngresa tu cédula para comenzar:');
      } else {
        session.state = 'MENU';
        await enviarWhatsApp(telefono, MENU);
      }
      break;

    case 'TRATAMIENTOS_CEDULA':
      session.data.cedula = texto;
      const tratamientos = await buscarTratamientosPorCedula(texto);
      if (tratamientos.length === 0) {
        await enviarWhatsApp(telefono, `No tienes tratamientos activos registrados.\n\n0  Volver al menú principal`);
      } else {
        let msg = `TRATAMIENTOS ACTIVOS (${tratamientos.length})\n\n`;
        for (const t of tratamientos) {
          const prox = new Date(t.proxima_toma);
          const diff = prox - new Date();
          const horas = Math.floor(diff / 3600000);
          const mins = Math.floor((diff % 3600000) / 60000);
          msg += `${t.nombre_tratamiento}\n`;
          msg += `  Dosis: ${t.dosis}\n`;
          msg += `  Cada: ${t.frecuencia_horas} horas\n`;
          msg += `  Próxima toma: ${prox.toLocaleDateString('es-VE')} ${prox.toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })}\n`;
          if (horas >= 0 && horas < 999) msg += `  Faltan: ${horas}h ${mins}m\n`;
          msg += `  ${t.centro_nombre}\n\n`;
        }
        msg += '0  Volver al menú principal';
        await enviarWhatsApp(telefono, msg);
      }
      session.state = 'MENU';
      break;

    case 'AGENDAR_PASO1':
      session.data.cedula = texto;
      const pacExistente = await buscarPacientePorCedula(texto);
      if (pacExistente) {
        session.data.paciente_id = pacExistente.id;
        session.data.nombre = pacExistente.nombre;
        session.data.apellido = pacExistente.apellido || '';
        session.data.telefono_paciente = pacExistente.telefono || telefono;
        session.data.email = pacExistente.email || '';
        session.data.direccion = pacExistente.direccion || '';
        session.data.fecha_nacimiento = pacExistente.fecha_nacimiento || '';
        session.data.genero = pacExistente.genero || '';

        await enviarWhatsApp(telefono, `Bienvenido de nuevo, ${pacExistente.nombre}${pacExistente.apellido ? ' ' + pacExistente.apellido : ''}!`);

        session.data.centros = await listarCentros();
        if (session.data.centros.length === 0) {
          await enviarWhatsApp(telefono, 'No hay centros médicos disponibles.\n0  Volver al menú');
          session.state = 'MENU';
          return;
        }
        let centrosMsg = 'SELECCIONA EL CENTRO MÉDICO\n\n';
        session.data.centros.forEach((c, i) => {
          centrosMsg += `${i + 1}  ${c.nombre}\n   ${c.direccion || ''}\n`;
        });
        centrosMsg += '\nResponde el número del centro:';
        await enviarWhatsApp(telefono, centrosMsg);
        session.state = 'AGENDAR_CENTRO';
      } else {
        await enviarWhatsApp(telefono, `No te encontramos registrado. Vamos a crear tu perfil.\n\nEscribe tu NOMBRE completo (nombres y apellidos):`);
        session.state = 'AGENDAR_NOMBRE';
      }
      break;

    case 'AGENDAR_NOMBRE':
      session.data.nombre = texto;
      await enviarWhatsApp(telefono, 'Ahora escribe tu TELÉFONO (ej: +584121234567):');
      session.state = 'AGENDAR_TELEFONO';
      break;

    case 'AGENDAR_TELEFONO':
      session.data.telefono_paciente = texto;
      await enviarWhatsApp(telefono, 'Escribe tu CORREO ELECTRÓNICO (o escribe "no" si no tienes):');
      session.state = 'AGENDAR_EMAIL';
      break;

    case 'AGENDAR_EMAIL':
      session.data.email = (texto.toLowerCase() === 'no' || texto.toLowerCase() === 'ninguno') ? '' : texto;
      await enviarWhatsApp(telefono, 'Escribe tu DIRECCIÓN de domicilio:');
      session.state = 'AGENDAR_DIRECCION';
      break;

    case 'AGENDAR_DIRECCION':
      session.data.direccion = texto;
      await enviarWhatsApp(telefono, '¿Cuál es tu FECHA DE NACIMIENTO?\n\nFormato: DD/MM/AAAA (ej: 15/03/1990)\n(O escribe "no" si prefieres no decirla)');
      session.state = 'AGENDAR_FECHA_NAC';
      break;

    case 'AGENDAR_FECHA_NAC':
      if (texto.toLowerCase() !== 'no') {
        const partes = texto.split('/');
        session.data.fecha_nacimiento = partes.length === 3 ? `${partes[2]}-${partes[1]}-${partes[0]}` : '';
      } else {
        session.data.fecha_nacimiento = '';
      }
      await enviarWhatsApp(telefono, '¿Cuál es tu GÉNERO?\n\n1  Masculino\n2  Femenino\n3  Otro\n0  Prefiero no decirlo');
      session.state = 'AGENDAR_GENERO';
      break;

    case 'AGENDAR_GENERO':
      const generos = { '1': 'Masculino', '2': 'Femenino', '3': 'Otro', '0': '' };
      session.data.genero = generos[texto] || '';
      session.data.centros = await listarCentros();
      if (session.data.centros.length === 0) {
        await enviarWhatsApp(telefono, 'No hay centros disponibles.\n0  Volver al menú');
        session.state = 'MENU';
        return;
      }
      let cm2 = 'SELECCIONA EL CENTRO MÉDICO\n\n';
      session.data.centros.forEach((c, i) => { cm2 += `${i + 1}  ${c.nombre}\n   ${c.direccion || ''}\n`; });
      cm2 += '\nResponde el número del centro:';
      await enviarWhatsApp(telefono, cm2);
      session.state = 'AGENDAR_CENTRO';
      break;

    case 'AGENDAR_CENTRO':
      const idxCentro = parseInt(texto) - 1;
      if (isNaN(idxCentro) || !session.data.centros || !session.data.centros[idxCentro]) {
        await enviarWhatsApp(telefono, 'Número inválido. Elige un número del listado de centros:');
        return;
      }
      session.data.centro_id = session.data.centros[idxCentro].id;
      session.data.centro_nombre = session.data.centros[idxCentro].nombre;

      session.data.especialidades = await listarEspecialidades(session.data.centro_id);
      if (session.data.especialidades.length === 0) {
        await enviarWhatsApp(telefono, `No hay especialidades en ${session.data.centro_nombre}.\n\n1  Elegir otro centro\n0  Volver al menú`);
        session.state = 'AGENDAR_OTRO_CENTRO';
        return;
      }
      let espMsg = `ESPECIALIDADES EN ${session.data.centro_nombre.toUpperCase()}\n\n`;
      session.data.especialidades.forEach((e, i) => { espMsg += `${i + 1}  ${e.especialidad}\n`; });
      espMsg += '\nResponde el número de la especialidad:';
      await enviarWhatsApp(telefono, espMsg);
      session.state = 'AGENDAR_ESPECIALIDAD';
      break;

    case 'AGENDAR_OTRO_CENTRO':
      if (texto === '1') {
        session.data.centros = await listarCentros();
        let cmsg = 'SELECCIONA EL CENTRO MÉDICO\n\n';
        session.data.centros.forEach((c, i) => { cmsg += `${i + 1}  ${c.nombre}\n`; });
        cmsg += '\nResponde el número:';
        await enviarWhatsApp(telefono, cmsg);
        session.state = 'AGENDAR_CENTRO';
      } else {
        session.state = 'MENU';
        await enviarWhatsApp(telefono, MENU);
      }
      break;

    case 'AGENDAR_ESPECIALIDAD':
      const idxEsp = parseInt(texto) - 1;
      if (!session.data.especialidades) session.data.especialidades = await listarEspecialidades(session.data.centro_id);
      if (isNaN(idxEsp) || !session.data.especialidades[idxEsp]) {
        await enviarWhatsApp(telefono, 'Número inválido. Elige una especialidad del listado:');
        return;
      }
      session.data.especialidad = session.data.especialidades[idxEsp].especialidad;
      session.data.doctores = await listarDoctores(session.data.centro_id, session.data.especialidad);
      if (session.data.doctores.length === 0) {
        await enviarWhatsApp(telefono, `No hay doctores para ${session.data.especialidad} en ${session.data.centro_nombre}.\n\n1  Elegir otra especialidad\n0  Volver al menú`);
        session.state = 'AGENDAR_OTRA_ESP';
        return;
      }
      let docMsg = `DOCTORES EN ${session.data.centro_nombre.toUpperCase()}\nEspecialidad: ${session.data.especialidad}\n\n`;
      session.data.doctores.forEach((d, i) => {
        docMsg += `${i + 1}  Dr. ${d.nombre}\n`;
        if (d.registro_medico) docMsg += `   MPPS: ${d.registro_medico}\n`;
      });
      docMsg += '\nResponde el número del doctor:';
      await enviarWhatsApp(telefono, docMsg);
      session.state = 'AGENDAR_DOCTOR';
      break;

    case 'AGENDAR_OTRA_ESP':
      if (texto === '1') {
        session.data.especialidades = await listarEspecialidades(session.data.centro_id);
        if (session.data.especialidades.length === 0) {
          await enviarWhatsApp(telefono, 'No hay especialidades.\n0  Volver al menú');
          session.state = 'MENU';
          return;
        }
        let em = 'ESPECIALIDADES\n\n';
        session.data.especialidades.forEach((e, i) => { em += `${i + 1}  ${e.especialidad}\n`; });
        em += '\nResponde el número:';
        await enviarWhatsApp(telefono, em);
        session.state = 'AGENDAR_ESPECIALIDAD';
      } else {
        session.state = 'MENU';
        await enviarWhatsApp(telefono, MENU);
      }
      break;

    case 'AGENDAR_DOCTOR':
      const idxDoc = parseInt(texto) - 1;
      if (isNaN(idxDoc) || !session.data.doctores[idxDoc]) {
        await enviarWhatsApp(telefono, 'Número inválido. Elige un doctor del listado:');
        return;
      }
      session.data.doctor_id = session.data.doctores[idxDoc].id;
      session.data.doctor_nombre = session.data.doctores[idxDoc].nombre;
      await enviarWhatsApp(telefono, `Has seleccionado al Dr. ${session.data.doctor_nombre}.\n\nAhora describe el MOTIVO DE TU CONSULTA (ej: dolor de cabeza, control mensual, etc.):`);
      session.state = 'AGENDAR_MOTIVO';
      break;

    case 'AGENDAR_MOTIVO':
      session.data.motivo = texto;
      await enviarWhatsApp(telefono, `TIPO DE CONSULTA\n\n1  Presencial - Asistes al consultorio\n2  Teleconsulta - Videollamada\n3  A Domicilio - El médico va a tu casa\n\nResponde el número:`);
      session.state = 'AGENDAR_TIPO';
      break;

    case 'AGENDAR_TIPO':
      const tipos = { '1': 'Presencial', '2': 'Teleconsulta', '3': 'Domicilio' };
      if (!tipos[texto]) {
        await enviarWhatsApp(telefono, 'Opción inválida. 1=Presencial, 2=Teleconsulta, 3=Domicilio:');
        return;
      }
      session.data.tipo_consulta = tipos[texto];
      await enviarWhatsApp(telefono, 'FECHA DE LA CITA\n\nFormato: DD/MM/AAAA (ej: 25/12/2025)\n\nHorario: Lun-Vie, 8:00 AM - 5:00 PM.');
      session.state = 'AGENDAR_FECHA';
      break;

    case 'AGENDAR_FECHA':
      const partesFecha = texto.split('/');
      if (partesFecha.length !== 3) {
        await enviarWhatsApp(telefono, 'Formato inválido. Usa DD/MM/AAAA (ej: 25/12/2025):');
        return;
      }
      const fechaStr = `${partesFecha[2]}-${partesFecha[1]}-${partesFecha[0]}`;
      const fechaDate = new Date(fechaStr + 'T12:00:00');
      if (isNaN(fechaDate.getTime())) {
        await enviarWhatsApp(telefono, 'Fecha inválida. Usa DD/MM/AAAA:');
        return;
      }
      const hoy = new Date(); hoy.setHours(0, 0, 0, 0);
      if (fechaDate < hoy) {
        await enviarWhatsApp(telefono, 'La fecha ya pasó. Ingresa una FUTURA (DD/MM/AAAA):');
        return;
      }
      const diaSem = fechaDate.getDay();
      if (diaSem === 0 || diaSem === 6) {
        await enviarWhatsApp(telefono, 'Solo LUNES A VIERNES. Ingresa un día de semana (DD/MM/AAAA):');
        return;
      }
      session.data.fecha = fechaStr;

      const horas = await obtenerHorasDisponibles(session.data.centro_id, session.data.doctor_id, fechaStr);
      if (horas.length === 0) {
        await enviarWhatsApp(telefono, `No hay horas disponibles para el ${texto}.\n\n1  Elegir otra fecha\n0  Volver al menú`);
        session.state = 'AGENDAR_OTRA_FECHA';
        return;
      }
      let horasMsg = `HORAS DISPONIBLES PARA EL ${texto}\n\n`;
      horas.forEach((h, i) => {
        const h12 = new Date(`2000-01-01T${h}`).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
        horasMsg += `${i + 1}  ${h12}\n`;
      });
      horasMsg += '\nResponde el número de la hora:';
      await enviarWhatsApp(telefono, horasMsg);
      session.state = 'AGENDAR_HORA';
      break;

    case 'AGENDAR_OTRA_FECHA':
      if (texto === '1') {
        await enviarWhatsApp(telefono, 'Ingresa la nueva fecha (DD/MM/AAAA):');
        session.state = 'AGENDAR_FECHA';
      } else {
        session.state = 'MENU';
        await enviarWhatsApp(telefono, MENU);
      }
      break;

    case 'AGENDAR_HORA':
      const idxHora = parseInt(texto) - 1;
      const horasDisp = await obtenerHorasDisponibles(session.data.centro_id, session.data.doctor_id, session.data.fecha);
      if (isNaN(idxHora) || !horasDisp[idxHora]) {
        await enviarWhatsApp(telefono, 'Hora inválida. Elige un número del listado:');
        return;
      }
      session.data.hora = horasDisp[idxHora];

      const hora12 = new Date(`2000-01-01T${session.data.hora}`).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });
      const fechaLegible = new Date(session.data.fecha + 'T12:00:00').toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

      let confMsg = `CONFIRMAR CITA\n\n`;
      confMsg += `Paciente: ${session.data.nombre} ${session.data.apellido || ''}\n`;
      confMsg += `Cédula: ${session.data.cedula}\n`;
      confMsg += `Centro: ${session.data.centro_nombre}\n`;
      confMsg += `Especialidad: ${session.data.especialidad}\n`;
      confMsg += `Doctor: Dr. ${session.data.doctor_nombre}\n`;
      confMsg += `Fecha: ${fechaLegible}\n`;
      confMsg += `Hora: ${hora12}\n`;
      confMsg += `Motivo: ${session.data.motivo}\n`;
      confMsg += `Tipo: ${session.data.tipo_consulta}\n\n`;
      confMsg += `1  SÍ, confirmar cita\n2  NO, cancelar`;
      await enviarWhatsApp(telefono, confMsg);
      session.state = 'AGENDAR_CONFIRMAR';
      break;

    case 'AGENDAR_CONFIRMAR':
      if (texto === '1') {
        try {
          const result = await crearCita(session.data);
          if (result.success) {
            const fechaOk = new Date(session.data.fecha + 'T12:00:00').toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
            const horaOk = new Date(`2000-01-01T${session.data.hora}`).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' });

            await enviarWhatsApp(telefono, `CITA AGENDADA CON ÉXITO\n\nFecha: ${fechaOk}\nHora: ${horaOk}\nDoctor: Dr. ${session.data.doctor_nombre}\nCentro: ${session.data.centro_nombre}\nTipo: ${session.data.tipo_consulta}\n\nRecibirás un recordatorio 24h antes.\n\nIMPORTANTE: Llega 30 minutos antes.\n\n0  Volver al menú principal`);

            // Notificar al doctor asignado
            const docInfo = await buscarDoctor(session.data.doctor_id);
            if (docInfo && docInfo.telefono) {
              await enviarWhatsApp(docInfo.telefono, `NUEVA CITA AGENDADA\n\nPaciente: ${session.data.nombre} ${session.data.apellido || ''}\nCédula: ${session.data.cedula}\nTel: ${session.data.telefono_paciente}\nFecha: ${fechaOk}\nHora: ${horaOk}\nMotivo: ${session.data.motivo}\nTipo: ${session.data.tipo_consulta}\nCentro: ${session.data.centro_nombre}`);
            }
          } else {
            await enviarWhatsApp(telefono, `Error al agendar: ${result.error}\n\n0  Volver al menú principal`);
          }
        } catch (err) {
          await enviarWhatsApp(telefono, `Error del sistema. Intenta más tarde.\n\n0  Volver al menú principal`);
        }
      } else {
        await enviarWhatsApp(telefono, 'Cita cancelada.\n\n0  Volver al menú principal');
      }
      session.state = 'MENU';
      break;

    case 'RECETAS_CEDULA':
      session.data.cedula = texto;
      const recetas = await buscarRecetasPorCedula(texto);
      if (recetas.length === 0) {
        await enviarWhatsApp(telefono, `No tienes recetas electrónicas registradas.\n\n0  Volver al menú principal`);
      } else {
        let msg = `MIS RECETAS (${recetas.length})\n\n`;
        for (const r of recetas) {
          msg += `Fecha: ${new Date(r.fecha_emision).toLocaleDateString('es-VE')}\n`;
          msg += `Diagnóstico: ${r.diagnostico}\n`;
          if (r.cie10) msg += `CIE-10: ${r.cie10}\n`;
          if (r.doctor_nombre) msg += `Doctor: Dr. ${r.doctor_nombre}\n`;
          msg += `${r.centro_nombre}\n`;
          try {
            const meds = JSON.parse(r.medicamentos || '[]');
            if (meds.length > 0) {
              msg += `Medicamentos:\n`;
              meds.forEach(m => { msg += `  - ${m.nombre} ${m.dosis} c/${m.frecuencia}h\n`; });
            }
          } catch (e) {}
          msg += '\n';
        }
        msg += '0  Volver al menú principal';
        await enviarWhatsApp(telefono, msg);
      }
      session.state = 'MENU';
      break;

    case 'HISTORIAL_CEDULA':
      session.data.cedula = texto;
      const historial = await buscarHistorialPorCedula(texto);
      if (historial.length === 0) {
        await enviarWhatsApp(telefono, `No tienes registros en tu historial clínico.\n\n0  Volver al menú principal`);
      } else {
        let msg = `HISTORIAL CLÍNICO (${historial.length} registros)\n\n`;
        for (const h of historial) {
          msg += `${new Date(h.fecha).toLocaleDateString('es-VE')} - ${h.tipo}\n`;
          msg += `  ${h.descripcion?.substring(0, 100)}\n`;
          msg += `  ${h.centro_nombre}\n\n`;
        }
        msg += '0  Volver al menú principal';
        await enviarWhatsApp(telefono, msg);
      }
      session.state = 'MENU';
      break;

    case 'MENSAJE_MEDICO':
      if (texto.toLowerCase() === 'cancelar') {
        session.state = 'MENU';
        await enviarWhatsApp(telefono, MENU);
        return;
      }
      session.data.mensaje = texto;
      await enviarWhatsApp(telefono, 'Para que el médico pueda identificarte, escribe tu CÉDULA (solo números):');
      session.state = 'MENSAJE_CEDULA';
      break;

    case 'MENSAJE_CEDULA':
      session.data.cedula = texto;
      const pac = await buscarPacientePorCedula(texto);
      const nombrePac = pac ? `${pac.nombre} ${pac.apellido || ''}`.trim() : 'Desconocido';
      const telPac = pac ? pac.telefono : telefono;

      const msgMedico = `MENSAJE DE PACIENTE\n\nPaciente: ${nombrePac}\nTeléfono: ${telPac}\nCédula: ${texto}\n\nMensaje:\n"${session.data.mensaje}"\n\nFecha: ${new Date().toLocaleString('es-VE')}\n\n🔇 Bot silenciado para este paciente. Responde directamente a ${telPac}. El bot se reactiva en 1 hora.`;

      // Notificar al doctor asignado al paciente
      let doctorNotificado = false;
      if (pac && pac.doctor_id) {
        const docAsignado = await buscarDoctor(pac.doctor_id);
        if (docAsignado && docAsignado.telefono) {
          await enviarWhatsApp(docAsignado.telefono, msgMedico);
          await enviarWhatsApp(docAsignado.telefono, `🔇 Bot silenciado para ${nombrePac} (${telPac}). Responde directo. 1 hora para reactivación.`);
          doctorNotificado = true;
        }
      }
      if (!doctorNotificado) {
        console.log(`⚠️ Paciente ${nombrePac} (cédula ${texto}) no tiene médico asignado o el médico no tiene teléfono.`);
      }

      silencePatient(telefono, 'MENSAJE_MEDICO');

      await enviarWhatsApp(telefono, `Mensaje enviado al médico. Te responderá a la brevedad.\n\n0  Volver al menú principal`);
      session.state = 'MENU';
      break;

    default:
      session.state = 'MENU';
      await enviarWhatsApp(telefono, MENU);
  }
}

// ============================================================
// CONSULTAS A LA BASE DE DATOS
// ============================================================
async function buscarCitasPorCedula(cedula) {
  const [rows] = await pool.query(`
    SELECT c.fecha, c.hora, c.motivo, c.estado, c.tipo_consulta,
           cen.nombre AS centro_nombre, d.nombre AS doctor_nombre, d.especialidad
    FROM citas c
    JOIN pacientes p ON c.paciente_id = p.id
    JOIN centros_medicos cen ON c.centro_id = cen.id
    LEFT JOIN doctores d ON c.doctor_id = d.id
    WHERE p.cedula = ? AND p.activo = 1
    ORDER BY c.fecha DESC, c.hora DESC LIMIT 10
  `, [cedula]);
  return rows;
}

async function buscarTratamientosPorCedula(cedula) {
  const [rows] = await pool.query(`
    SELECT t.nombre_tratamiento, t.dosis, t.frecuencia_horas, t.proxima_toma,
           t.indicaciones, t.recordatorio_whatsapp, t.activo, cen.nombre AS centro_nombre
    FROM tratamientos t
    JOIN pacientes p ON t.paciente_id = p.id
    JOIN centros_medicos cen ON t.centro_id = cen.id
    WHERE p.cedula = ? AND t.activo = 1
    ORDER BY t.proxima_toma ASC
  `, [cedula]);
  return rows;
}

async function buscarPacientePorCedula(cedula) {
  const [rows] = await pool.query(`
    SELECT id, nombre, apellido, telefono, email, direccion,
           fecha_nacimiento, genero, doctor_id, centro_id
    FROM pacientes WHERE cedula = ? AND activo = 1 LIMIT 1
  `, [cedula]);
  return rows.length > 0 ? rows[0] : null;
}

async function buscarRecetasPorCedula(cedula) {
  const [rows] = await pool.query(`
    SELECT r.diagnostico, r.cie10, r.medicamentos, r.fecha_emision,
           cen.nombre AS centro_nombre, d.nombre AS doctor_nombre
    FROM recipes r
    JOIN pacientes p ON r.paciente_id = p.id
    JOIN centros_medicos cen ON r.centro_id = cen.id
    LEFT JOIN doctores d ON r.doctor_id = d.id
    WHERE p.cedula = ? AND p.activo = 1
    ORDER BY r.fecha_emision DESC LIMIT 5
  `, [cedula]);
  return rows;
}

async function buscarHistorialPorCedula(cedula) {
  const [rows] = await pool.query(`
    SELECT h.tipo, h.descripcion, h.observaciones, h.fecha, cen.nombre AS centro_nombre
    FROM historial_clinico h
    JOIN pacientes p ON h.paciente_id = p.id
    JOIN centros_medicos cen ON h.centro_id = cen.id
    WHERE p.cedula = ? AND p.activo = 1
    ORDER BY h.fecha DESC LIMIT 15
  `, [cedula]);
  return rows;
}

async function buscarDoctor(doctorId) {
  const [rows] = await pool.query(
    'SELECT id, nombre, email, telefono FROM doctores WHERE id = ? AND activo = 1 LIMIT 1',
    [doctorId]
  );
  return rows.length > 0 ? rows[0] : null;
}

async function listarCentros() {
  const [rows] = await pool.query(
    'SELECT id, nombre, direccion, telefono, horario_atencion FROM centros_medicos WHERE activo = 1 ORDER BY nombre'
  );
  return rows;
}

async function listarEspecialidades(centroId) {
  const [rows] = await pool.query(`
    SELECT DISTINCT d.especialidad FROM doctores d
    JOIN doctor_centros dc ON d.id = dc.doctor_id
    WHERE dc.centro_id = ? AND d.activo = 1 AND dc.activo = 1 AND d.especialidad IS NOT NULL
    ORDER BY d.especialidad
  `, [centroId]);
  return rows;
}

async function listarDoctores(centroId, especialidad) {
  const [rows] = await pool.query(`
    SELECT d.id, d.nombre, d.especialidad, d.registro_medico
    FROM doctores d JOIN doctor_centros dc ON d.id = dc.doctor_id
    WHERE dc.centro_id = ? AND d.especialidad = ? AND d.activo = 1 AND dc.activo = 1
    ORDER BY d.nombre
  `, [centroId, especialidad]);
  return rows;
}

async function obtenerHorasDisponibles(centroId, doctorId, fecha) {
  const diaSemana = new Date(fecha + 'T12:00:00').getDay();
  const [horarios] = await pool.query(`
    SELECT MIN(hora_inicio) as hora_inicio, MAX(hora_fin) as hora_fin,
           MIN(pausa_inicio) as pausa_inicio, MAX(pausa_fin) as pausa_fin,
           MIN(hora_inicio_tarde) as hora_inicio_tarde, MAX(hora_fin_tarde) as hora_fin_tarde
    FROM doctor_horarios
    WHERE centro_id = ? AND doctor_id = ? AND dia_semana = ? AND activo = 1
  `, [centroId, doctorId, diaSemana]);

  let horas = [];
  if (horarios.length > 0 && horarios[0].hora_inicio) {
    const h = horarios[0];
    const hi = parseInt(h.hora_inicio.substring(0, 2));
    const hf = parseInt(h.hora_fin.substring(0, 2));
    const pi = h.pausa_inicio ? parseInt(h.pausa_inicio.substring(0, 2)) : null;
    const pf = h.pausa_fin ? parseInt(h.pausa_fin.substring(0, 2)) : null;
    const hit = h.hora_inicio_tarde ? parseInt(h.hora_inicio_tarde.substring(0, 2)) : null;
    const hft = h.hora_fin_tarde ? parseInt(h.hora_fin_tarde.substring(0, 2)) : null;
    for (let i = hi; i < hf; i++) {
      if (pi !== null && i >= pi && i < pf) continue;
      horas.push(`${String(i).padStart(2, '0')}:00:00`);
    }
    if (hit !== null && hft !== null) {
      for (let i = hit; i < hft; i++) horas.push(`${String(i).padStart(2, '0')}:00:00`);
    }
  } else {
    for (let i = 8; i < 12; i++) horas.push(`${String(i).padStart(2, '0')}:00:00`);
    for (let i = 14; i < 17; i++) horas.push(`${String(i).padStart(2, '0')}:00:00`);
  }

  const [ocupadas] = await pool.query(
    `SELECT hora FROM citas WHERE doctor_id = ? AND centro_id = ? AND fecha = ? AND estado NOT IN ('Completada','Cancelada')`,
    [doctorId, centroId, fecha]
  );
  const horasOcupadas = new Set(ocupadas.map(r => r.hora));
  return [...new Set(horas)].filter(h => !horasOcupadas.has(h)).sort();
}

async function crearCita(data) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    let [pacientes] = await conn.query(
      'SELECT id FROM pacientes WHERE cedula = ? AND activo = 1 LIMIT 1', [data.cedula]
    );
    let pacienteId;

    if (pacientes.length > 0) {
      pacienteId = pacientes[0].id;
      await conn.query(
        `UPDATE pacientes SET telefono = ?, email = ?, direccion = ?,
         fecha_nacimiento = ?, genero = ? WHERE id = ?`,
        [data.telefono_paciente || '', data.email || '', data.direccion || '',
         data.fecha_nacimiento || null, data.genero || '', pacienteId]
      );
    } else {
      const hash = '$2y$10$' + require('crypto').randomBytes(22).toString('base64').replace(/\+/g, '.').substring(0, 22);
      const username = (data.nombre || 'paciente').toLowerCase().replace(/\s/g, '') + data.cedula;
      const [result] = await conn.query(
        `INSERT INTO pacientes (centro_id, doctor_id, nombre, apellido, cedula, telefono, email,
         direccion, fecha_nacimiento, genero, password, username, activo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [data.centro_id, data.doctor_id, data.nombre, data.apellido || '', data.cedula,
         data.telefono_paciente || telefono, data.email || '', data.direccion || '',
         data.fecha_nacimiento || null, data.genero || '', hash, username]
      );
      pacienteId = result.insertId;
    }

    const [result] = await conn.query(
      `INSERT INTO citas (centro_id, doctor_id, paciente_id, fecha, hora, motivo, tipo_consulta, estado)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Pendiente')`,
      [data.centro_id, data.doctor_id, pacienteId, data.fecha, data.hora, data.motivo, data.tipo_consulta]
    );

    await conn.query(
      `INSERT INTO historial_clinico (centro_id, paciente_id, doctor_id, tipo, descripcion, observaciones)
       VALUES (?, ?, ?, 'Consulta', ?, ?)`,
      [data.centro_id, pacienteId, data.doctor_id,
       `Solicitud de cita - ${data.motivo?.substring(0, 200)}`,
       `Agendado por WhatsApp Bot. Tipo: ${data.tipo_consulta}`]
    );

    await conn.commit();
    return { success: true, citaId: result.insertId, pacienteId };
  } catch (err) {
    await conn.rollback();
    return { success: false, error: err.message };
  } finally {
    conn.release();
  }
}

// ============================================================
// RECORDATORIOS (CRON)
// ============================================================
async function enviarRecordatoriosTratamientos() {
  try {
    const ahora = new Date();
    const dentroDe1h = new Date(ahora.getTime() + 60 * 60 * 1000);
    const [rows] = await pool.query(`
      SELECT t.*, p.nombre AS paciente_nombre, p.telefono, c.nombre AS centro_nombre
      FROM tratamientos t
      JOIN pacientes p ON t.paciente_id = p.id
      JOIN centros_medicos c ON t.centro_id = c.id
      WHERE t.proxima_toma BETWEEN ? AND ?
        AND t.recordatorio_whatsapp = 'SI' AND t.activo = 1
    `, [ahora.toISOString().slice(0, 19).replace('T', ' '), dentroDe1h.toISOString().slice(0, 19).replace('T', ' ')]);

    for (const t of rows) {
      if (isSilenced(t.telefono)) continue;
      await enviarWhatsApp(t.telefono, `RECORDATORIO DE MEDICACIÓN\n\nHola ${t.paciente_nombre}, es hora de tu tratamiento:\n\n${t.nombre_tratamiento}\nDosis: ${t.dosis}\n${t.centro_nombre}\nHora: ${new Date(t.proxima_toma).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })}\n\nSi ya lo tomaste, ignora este mensaje.`);
      console.log(`Recordatorio: ${t.paciente_nombre} - ${t.nombre_tratamiento}`);
      const nuevaToma = new Date(t.proxima_toma);
      nuevaToma.setHours(nuevaToma.getHours() + t.frecuencia_horas);
      await pool.query('UPDATE tratamientos SET proxima_toma = ? WHERE id = ?',
        [nuevaToma.toISOString().slice(0, 19).replace('T', ' '), t.id]);
    }
    return rows.length;
  } catch (err) {
    console.error('Error recordatorios:', err.message);
    return 0;
  }
}

async function enviarRecordatoriosCitas() {
  try {
    const manana = new Date();
    manana.setDate(manana.getDate() + 1);
    const fechaStr = manana.toISOString().slice(0, 10);

    const [rows] = await pool.query(`
      SELECT c.*, p.nombre AS paciente_nombre, p.telefono,
             cen.nombre AS centro_nombre, d.nombre AS doctor_nombre
      FROM citas c
      JOIN pacientes p ON c.paciente_id = p.id
      JOIN centros_medicos cen ON c.centro_id = cen.id
      LEFT JOIN doctores d ON c.doctor_id = d.id
      WHERE c.fecha = ? AND c.estado IN ('Pendiente', 'Confirmada')
    `, [fechaStr]);

    for (const c of rows) {
      if (isSilenced(c.telefono)) continue;
      await enviarWhatsApp(c.telefono, `RECORDATORIO DE CITA MÉDICA\n\nHola ${c.paciente_nombre}, MAÑANA tienes una cita:\n\nCentro: ${c.centro_nombre}\nDoctor: Dr. ${c.doctor_nombre || 'Asignado'}\nFecha: ${new Date(c.fecha + 'T12:00:00').toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}\nHora: ${c.hora?.substring(0, 5)}\nMotivo: ${c.motivo}\n\nLlega 30 MINUTOS ANTES.`);
      console.log(`Recordatorio cita: ${c.paciente_nombre} - ${c.fecha}`);
    }
    return rows.length;
  } catch (err) {
    console.error('Error recordatorios citas:', err.message);
    return 0;
  }
}

// ============================================================
// RUTAS DEL SERVIDOR EXPRESS
// ============================================================

// ===== PÁGINA PRINCIPAL =====
app.get('/', (req, res) => {
  const conectado = conexionEstado === 'conectado';
  const telefono = sock?.user?.id?.split(':')[0] || '';
  const qrStatus = ultimoQR ? 'qr_pendiente' : conectado ? 'conectado' : conexionEstado;
  res.send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Portal de Especialidades - WhatsApp Bot</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap');*{font-family:'Inter',sans-serif;}</style>
</head>
<body class="bg-gray-50 min-h-screen">
<nav class="bg-white shadow-sm border-b px-6 py-4">
  <div class="max-w-5xl mx-auto flex items-center justify-between">
    <div class="flex items-center gap-2"><i class="fas fa-star-of-life text-blue-900 text-xl"></i><span class="text-lg font-bold text-blue-900">Portal de Especialidades</span></div>
    <div class="flex items-center gap-3 text-sm">
      <span class="px-3 py-1 rounded-full text-xs font-bold ${conectado ? 'bg-green-100 text-green-800' : 'bg-yellow-100 text-yellow-800'}">${conectado ? 'Conectado' : qrStatus === 'qr_pendiente' ? 'Esperando QR' : 'Desconectado'}</span>
    </div>
  </div>
</nav>
<div class="max-w-5xl mx-auto px-4 py-12">
  <div class="text-center mb-12">
    <div class="w-20 h-20 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4"><i class="fas fa-robot text-blue-900 text-3xl"></i></div>
    <h1 class="text-3xl font-bold text-gray-900">WhatsApp Bot</h1>
    <p class="text-gray-500 mt-2">Sistema de atención automática para pacientes</p>
  </div>

  ${qrStatus === 'qr_pendiente' ? `
  <div class="max-w-md mx-auto bg-white rounded-2xl shadow-sm border p-8 text-center mb-8">
    <h2 class="text-lg font-bold text-gray-900 mb-2">Escanear QR</h2>
    <p class="text-sm text-gray-500 mb-4">Abre WhatsApp en tu teléfono → 3 puntos → Dispositivos vinculados → Vincular</p>
    <div class="bg-white p-4 rounded-xl inline-block border shadow-sm">
      <img src="/qr-image" alt="QR Code" class="w-64 h-64">
    </div>
    <p class="text-xs text-gray-400 mt-4">El QR se actualiza automáticamente</p>
  </div>
  ` : conectado ? `
  <div class="max-w-md mx-auto bg-white rounded-2xl shadow-sm border p-8 text-center mb-8">
    <div class="w-16 h-16 bg-green-100 rounded-full flex items-center justify-center mx-auto mb-4"><i class="fas fa-check-circle text-green-600 text-3xl"></i></div>
    <h2 class="text-lg font-bold text-gray-900">WhatsApp Conectado</h2>
    <p class="text-sm text-gray-500 mt-1">${telefono}</p>
  </div>
  ` : `
  <div class="max-w-md mx-auto bg-white rounded-2xl shadow-sm border p-8 text-center mb-8">
    <div class="w-16 h-16 bg-red-100 rounded-full flex items-center justify-center mx-auto mb-4"><i class="fas fa-exclamation-triangle text-red-600 text-3xl"></i></div>
    <h2 class="text-lg font-bold text-gray-900">Desconectado</h2>
    <p class="text-sm text-gray-500 mt-1">Estado: ${conexionEstado}</p>
  </div>
  `}

  <div class="grid md:grid-cols-3 gap-4 max-w-2xl mx-auto">
    <a href="/panel" class="bg-white rounded-xl p-5 border hover:shadow-md transition text-center">
      <i class="fas fa-chart-pie text-blue-900 text-2xl mb-2"></i>
      <p class="font-semibold text-gray-900">Panel</p>
      <p class="text-xs text-gray-500">Estadísticas del consultorio</p>
    </a>
    <a href="/qr" class="bg-white rounded-xl p-5 border hover:shadow-md transition text-center">
      <i class="fas fa-qrcode text-blue-900 text-2xl mb-2"></i>
      <p class="font-semibold text-gray-900">QR</p>
      <p class="text-xs text-gray-500">Escanear código</p>
    </a>
    <a href="/health" class="bg-white rounded-xl p-5 border hover:shadow-md transition text-center">
      <i class="fas fa-heartbeat text-blue-900 text-2xl mb-2"></i>
      <p class="font-semibold text-gray-900">Health</p>
      <p class="text-xs text-gray-500">Estado del servidor</p>
    </a>
  </div>
</div>
<footer class="border-t py-6 text-center text-sm text-gray-400">Portal de Especialidades &copy; ${new Date().getFullYear()}</footer>
<script>setTimeout(function(){ location.reload(); }, 15000);</script>
</body>
</html>`);
});

// ===== PÁGINA QR (HTML con QR vía API externa) =====
app.get('/qr', (req, res) => {
  if (conexionEstado === 'conectado') {
    return res.redirect('/');
  }
  res.send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>QR - WhatsApp Bot</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap');*{font-family:'Inter',sans-serif;}</style>
</head>
<body class="bg-gray-50 min-h-screen flex items-center justify-center p-4">
<div class="bg-white rounded-3xl shadow-xl p-8 max-w-md w-full text-center">
  <div class="w-16 h-16 bg-blue-100 rounded-full flex items-center justify-center mx-auto mb-4"><i class="fab fa-whatsapp text-blue-900 text-3xl"></i></div>
  <h1 class="text-2xl font-bold text-gray-900 mb-2">Conectar WhatsApp</h1>
  <p class="text-gray-500 text-sm mb-6">Escanea este código con tu WhatsApp</p>
  <div class="bg-gray-50 p-4 rounded-2xl inline-block mb-4">
    <img src="/qr-image" alt="QR" class="w-72 h-72" id="qrImg">
  </div>
  <div class="bg-blue-50 rounded-xl p-4 text-left text-sm text-blue-800">
    <p class="font-semibold mb-1">Pasos:</p>
    <p>1. Abre WhatsApp en tu teléfono</p>
    <p>2. Toca los 3 puntos ⋮ (Android) o Configuración (iOS)</p>
    <p>3. Dispositivos vinculados → Vincular</p>
    <p>4. Escanea este código</p>
  </div>
  <p class="text-xs text-gray-400 mt-4">La página se actualiza automáticamente</p>
</div>
<script>
setInterval(function(){
  document.getElementById('qrImg').src = '/qr-image?' + new Date().getTime();
  fetch('/health').then(r=>r.json()).then(d=>{ if(d.conexion==='conectado') location.href='/'; });
}, 5000);
</script>
</body>
</html>`);
});

// ===== SERVIDOR QR (proxy desde API externa) =====
app.get('/qr-image', (req, res) => {
  try {
    if (!ultimoQR) {
      return res.status(200).type('text/html').send('<div style="font-family:sans-serif;text-align:center;padding:40px;color:#666"><h2>Esperando QR...</h2><p>El bot está iniciando. Refresca en unos segundos.</p></div>');
    }
    const qrEncoded = encodeURIComponent(ultimoQR);
    const url = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${qrEncoded}`;
    https.get(url, (apiRes) => {
      res.setHeader('Content-Type', apiRes.headers['content-type'] || 'image/png');
      apiRes.pipe(res);
    }).on('error', () => {
      res.redirect(url);
    });
  } catch (e) {
    res.status(500).send('Error generando QR');
  }
});

// ===== PANEL MÉDICO CON ESTADÍSTICAS =====
app.get('/panel', async (req, res) => {
  try {
    const [pacientes] = await pool.query('SELECT COUNT(*) as total FROM pacientes WHERE activo = 1');
    const [doctores] = await pool.query('SELECT COUNT(*) as total FROM doctores WHERE activo = 1');
    const [centros] = await pool.query('SELECT COUNT(*) as total FROM centros_medicos WHERE activo = 1');
    const [citasHoy] = await pool.query("SELECT COUNT(*) as total FROM citas WHERE fecha = CURDATE()");
    const [citasPend] = await pool.query("SELECT COUNT(*) as total FROM citas WHERE estado = 'Pendiente'");
    const [citasConf] = await pool.query("SELECT COUNT(*) as total FROM citas WHERE estado = 'Confirmada'");
    const [citasHoyLista] = await pool.query(`
      SELECT c.fecha, c.hora, c.motivo, c.estado, c.tipo_consulta,
             p.nombre as paciente, d.nombre as doctor, cen.nombre as centro
      FROM citas c JOIN pacientes p ON c.paciente_id = p.id
      JOIN centros_medicos cen ON c.centro_id = cen.id
      LEFT JOIN doctores d ON c.doctor_id = d.id
      WHERE c.fecha = CURDATE() ORDER BY c.hora ASC LIMIT 15
    `);
    const [tratamientos] = await pool.query("SELECT COUNT(*) as total FROM tratamientos WHERE activo = 1 AND recordatorio_whatsapp = 'SI'");
    const [ultimasCitas] = await pool.query(`
      SELECT c.fecha, c.hora, p.nombre as paciente, d.nombre as doctor, c.estado
      FROM citas c JOIN pacientes p ON c.paciente_id = p.id
      LEFT JOIN doctores d ON c.doctor_id = d.id
      ORDER BY c.fecha DESC, c.hora DESC LIMIT 10
    `);

    const conectado = conexionEstado === 'conectado';

    res.send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Panel - Portal de Especialidades</title>
<script src="https://cdn.tailwindcss.com"></script>
<link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.0/css/all.min.css">
<style>@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');*{font-family:'Inter',sans-serif;}.card{transition:all .2s;}.card:hover{transform:translateY(-2px);box-shadow:0 8px 25px rgba(0,0,0,.08);}</style>
</head>
<body class="bg-gray-50">
<nav class="bg-white shadow-sm border-b px-6 py-4 sticky top-0 z-40">
  <div class="max-w-6xl mx-auto flex items-center justify-between">
    <div class="flex items-center gap-2"><i class="fas fa-star-of-life text-blue-900 text-xl"></i><span class="text-lg font-bold text-blue-900">Panel Médico</span></div>
    <div class="flex items-center gap-3 text-sm">
      <span class="px-3 py-1 rounded-full text-xs font-bold ${conectado ? 'bg-green-100 text-green-800' : 'bg-red-100 text-red-800'}">${conectado ? 'WhatsApp OK' : 'Desconectado'}</span>
      <a href="/" class="text-blue-900 hover:underline"><i class="fas fa-home"></i></a>
    </div>
  </div>
</nav>
<div class="max-w-6xl mx-auto px-4 py-8">
  <div class="grid grid-cols-2 md:grid-cols-5 gap-4 mb-8">
    <div class="bg-white rounded-2xl p-5 border card"><div class="text-3xl font-bold text-blue-900">${pacientes[0].total}</div><p class="text-sm text-gray-500">Pacientes</p></div>
    <div class="bg-white rounded-2xl p-5 border card"><div class="text-3xl font-bold text-green-700">${doctores[0].total}</div><p class="text-sm text-gray-500">Médicos</p></div>
    <div class="bg-white rounded-2xl p-5 border card"><div class="text-3xl font-bold text-purple-700">${centros[0].total}</div><p class="text-sm text-gray-500">Centros</p></div>
    <div class="bg-white rounded-2xl p-5 border card"><div class="text-3xl font-bold text-amber-600">${citasHoy[0].total}</div><p class="text-sm text-gray-500">Citas Hoy</p></div>
    <div class="bg-white rounded-2xl p-5 border card"><div class="text-3xl font-bold text-red-600">${citasPend[0].total}</div><p class="text-sm text-gray-500">Pendientes</p></div>
  </div>

  <div class="grid md:grid-cols-2 gap-6 mb-8">
    <div class="bg-white rounded-2xl border p-6">
      <h2 class="text-lg font-bold text-gray-900 mb-4"><i class="fas fa-calendar-day text-blue-900 mr-2"></i>Citas de Hoy</h2>
      ${citasHoyLista.length === 0 ? '<p class="text-gray-400 text-sm">No hay citas para hoy.</p>' : ''}
      <div class="space-y-3">
        ${citasHoyLista.map(c => `
        <div class="flex items-start gap-3 p-2 hover:bg-gray-50 rounded-lg">
          <div class="text-center min-w-[50px]"><div class="text-sm font-bold text-blue-900">${c.hora?.substring(0,5)}</div></div>
          <div class="flex-1 min-w-0">
            <p class="font-semibold text-gray-900 text-sm">${c.paciente}</p>
            <p class="text-xs text-gray-500">${c.doctor || 'Sin asignar'} · ${c.centro}</p>
            <p class="text-xs text-gray-400 truncate">${c.motivo || ''}</p>
          </div>
          <span class="text-xs px-2 py-1 rounded-full font-bold ${c.estado === 'Confirmada' ? 'bg-green-100 text-green-800' : c.estado === 'Pendiente' ? 'bg-yellow-100 text-yellow-800' : c.estado === 'Completada' ? 'bg-blue-100 text-blue-800' : 'bg-red-100 text-red-800'}">${c.estado}</span>
        </div>
        `).join('')}
      </div>
    </div>

    <div class="bg-white rounded-2xl border p-6">
      <h2 class="text-lg font-bold text-gray-900 mb-4"><i class="fas fa-history text-blue-900 mr-2"></i>Últimas Citas</h2>
      <div class="overflow-x-auto">
        <table class="w-full text-sm">
          <thead><tr class="text-left text-xs text-gray-500 uppercase"><th class="pb-2">Fecha</th><th class="pb-2">Paciente</th><th class="pb-2">Doctor</th><th class="pb-2">Estado</th></tr></thead>
          <tbody class="divide-y divide-gray-100">
            ${ultimasCitas.map(c => `<tr class="hover:bg-gray-50"><td class="py-2">${new Date(c.fecha+'T12:00:00').toLocaleDateString('es-VE')} ${c.hora?.substring(0,5)}</td><td class="py-2 font-medium">${c.paciente}</td><td class="py-2 text-gray-500">${c.doctor || '-'}</td><td class="py-2"><span class="text-xs px-2 py-0.5 rounded-full font-bold ${c.estado === 'Confirmada' ? 'bg-green-100 text-green-800' : c.estado === 'Pendiente' ? 'bg-yellow-100 text-yellow-800' : c.estado === 'Completada' ? 'bg-blue-100 text-blue-800' : 'bg-red-100 text-red-800'}">${c.estado}</span></td></tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
  </div>

  <div class="grid md:grid-cols-2 gap-6">
    <div class="bg-white rounded-2xl border p-6">
      <h2 class="text-lg font-bold text-gray-900 mb-4"><i class="fas fa-bell text-amber-600 mr-2"></i>Pacientes Silenciados</h2>
      ${silenced.size === 0 ? '<p class="text-gray-400 text-sm">No hay pacientes silenciados.</p>' : ''}
      <div class="space-y-2">
        ${[...silenced.entries()].map(([tel, entry]) => {
          const remaining = Math.ceil(Math.max(0, SILENCE_DURATION_MS - (Date.now() - entry.silencedAt.getTime())) / 60000);
          return `<div class="flex items-center justify-between p-2 bg-amber-50 rounded-lg text-sm">
            <div><span class="font-medium">${tel}</span><br><span class="text-xs text-gray-400">${entry.silencedBy} · ${remaining} min restantes</span></div>
            <form action="/release" method="POST" style="display:inline">
              <input type="hidden" name="key" value="${process.env.BOT_API_KEY}">
              <input type="hidden" name="telefono" value="${tel}">
              <button type="submit" class="text-xs bg-blue-900 text-white px-3 py-1 rounded-full hover:bg-blue-800">Reactivar</button>
            </form>
          </div>`;
        }).join('')}
      </div>
    </div>

    <div class="bg-white rounded-2xl border p-6">
      <h2 class="text-lg font-bold text-gray-900 mb-4"><i class="fas fa-info-circle text-blue-900 mr-2"></i>Estado del Bot</h2>
      <div class="space-y-3 text-sm">
        <div class="flex justify-between"><span class="text-gray-500">WhatsApp</span><span class="font-semibold ${conectado ? 'text-green-600' : 'text-red-600'}">${conectado ? 'Conectado' : conexionEstado}</span></div>
        <div class="flex justify-between"><span class="text-gray-500">Número</span><span class="font-semibold">${sock?.user?.id?.split(':')[0] || '-'}</span></div>
        <div class="flex justify-between"><span class="text-gray-500">Sesiones activas</span><span class="font-semibold">${sessions.size}</span></div>
        <div class="flex justify-between"><span class="text-gray-500">Silenciados</span><span class="font-semibold">${silenced.size}</span></div>
        <div class="flex justify-between"><span class="text-gray-500">Tratamientos con WA</span><span class="font-semibold">${tratamientos[0].total}</span></div>
        <div class="flex justify-between"><span class="text-gray-500">Citas Pendientes</span><span class="font-semibold">${citasPend[0].total}</span></div>
        <div class="flex justify-between"><span class="text-gray-500">Citas Confirmadas</span><span class="font-semibold">${citasConf[0].total}</span></div>
        <div class="flex justify-between"><span class="text-gray-500">Uptime</span><span class="font-semibold">${Math.floor(process.uptime() / 60)} min</span></div>
      </div>
    </div>
  </div>
</div>
<footer class="border-t py-6 text-center text-sm text-gray-400">Portal de Especialidades &copy; ${new Date().getFullYear()} · <a href="/" class="text-blue-900 hover:underline">Inicio</a></footer>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Error: ' + err.message);
  }
});

// ===== API: silenciar =====
app.post('/silence', async (req, res) => {
  const apiKey = req.query.key || req.headers['x-api-key'] || req.body?.key;
  if (apiKey !== process.env.BOT_API_KEY) return res.status(403).json({ error: 'Invalid API key' });
  const { telefono, motivo } = req.body || {};
  if (!telefono) return res.status(400).json({ error: 'Missing telefono' });
  silencePatient(telefono, motivo || 'API');
  res.json({ ok: true, telefono, action: 'silenced' });
});

// ===== API: reactivar =====
app.post('/release', async (req, res) => {
  const apiKey = req.query.key || req.headers['x-api-key'] || req.body?.key;
  if (apiKey !== process.env.BOT_API_KEY) return res.status(403).json({ error: 'Invalid API key' });
  const { telefono } = req.body || {};
  if (!telefono) {
    // Si viene del formulario HTML (x-www-form-urlencoded)
    const bodyKey = req.body?.key;
    const bodyTel = req.body?.telefono;
    if (bodyKey === process.env.BOT_API_KEY && bodyTel) {
      releasePatient(bodyTel);
      return res.redirect('/panel');
    }
    return res.status(400).json({ error: 'Missing telefono' });
  }
  releasePatient(telefono);
  if (req.body?.mensaje) await enviarWhatsApp(telefono, req.body.mensaje);
  res.json({ ok: true, telefono, action: 'released' });
});

// ===== API: estado silencios =====
app.get('/silence-status', async (req, res) => {
  const apiKey = req.query.key || req.headers['x-api-key'];
  if (apiKey !== process.env.BOT_API_KEY) return res.status(403).json({ error: 'Invalid API key' });
  const status = {};
  for (const [tel, entry] of silenced) {
    const remaining = SILENCE_DURATION_MS - (Date.now() - entry.silencedAt.getTime());
    status[tel] = { silencedAt: entry.silencedAt.toISOString(), silencedBy: entry.silencedBy, remainingMin: Math.ceil(Math.max(0, remaining) / 60000) };
  }
  res.json({ ok: true, count: silenced.size, silenced: status });
});

// ===== CRON: recordatorios =====
app.get('/remind', async (req, res) => {
  try {
    const apiKey = req.query.key || req.headers['x-api-key'];
    if (apiKey !== process.env.BOT_API_KEY) return res.status(403).json({ error: 'Invalid API key' });
    const t = await enviarRecordatoriosTratamientos();
    const c = await enviarRecordatoriosCitas();
    res.json({ ok: true, recordatorios_tratamientos: t, recordatorios_citas: c, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== API: notificar desde PHP =====
app.post('/notify', async (req, res) => {
  try {
    const apiKey = req.query.key || req.headers['x-api-key'] || req.body?.key;
    if (apiKey !== process.env.BOT_API_KEY) return res.status(403).json({ error: 'Invalid API key' });
    const { telefono, mensaje } = req.body || {};
    if (telefono && mensaje) {
      await enviarWhatsApp(telefono, mensaje);
      res.json({ ok: true, sent: true });
    } else {
      res.json({ ok: false, msg: 'Missing telefono or mensaje' });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ===== HEALTH CHECK =====
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    conexion: conexionEstado,
    whatsapp_numero: sock?.user?.id?.split(':')[0] || null,
    sesiones_activas: sessions.size,
    pacientes_silenciados: silenced.size,
    uptime: process.uptime(),
  });
});

// ============================================================
// INICIO
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('╔══════════════════════════════════╗');
  console.log('║   WHATSAPP BOT - CONSULTORIO     ║');
  console.log('╚══════════════════════════════════╝');
  console.log(` Puerto:  ${PORT}`);
  console.log('');
  console.log(' Endpoints:');
  console.log(`  QR:         GET  /qr`);
  console.log(`  Silenciar:  POST /silence`);
  console.log(`  Reactivar:  POST /release`);
  console.log(`  Recordatorios: GET /remind?key=...`);
  console.log(`  Health:     GET  /health`);
  console.log('');
  console.log(' Iniciando WhatsApp...');
});

iniciarWhatsApp();
