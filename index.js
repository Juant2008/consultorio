equire('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const axios = require('axios');
const cors = require('cors');
const morgan = require('morgan');

const app = express();
app.use(cors());
app.use(morgan('short'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
// Cuando el doctor interviene con un paciente, el bot se calla
// y se reactiva solo después de 1 hora sin actividad humana.
// ============================================================

// silenced: Map<telefonoPaciente, { silencedAt: Date, silencerBy: string }>
const silenced = new Map();

const SILENCE_DURATION_MS = 60 * 60 * 1000; // 1 hora

function isSilenced(telefono) {
  if (!silenced.has(telefono)) return false;
  const entry = silenced.get(telefono);
  const elapsed = Date.now() - entry.silencedAt.getTime();
  if (elapsed >= SILENCE_DURATION_MS) {
    silenced.delete(telefono);
    console.log(`🔊 Bot reactivado automáticamente para ${telefono} (pasó 1 hora)`);
    return false;
  }
  return true;
}

function silencePatient(telefonoPaciente, silencedBy) {
  silenced.set(telefonoPaciente, {
    silencedAt: new Date(),
    silencedBy,
  });
  console.log(`🔇 Bot silenciado para ${telefonoPaciente} por ${silencedBy}`);
}

function releasePatient(telefonoPaciente) {
  silenced.delete(telefonoPaciente);
  console.log(`🔊 Bot reactivado manualmente para ${telefonoPaciente}`);
}

function getTimeUntilRelease(telefono) {
  if (!silenced.has(telefono)) return 0;
  const entry = silenced.get(telefono);
  const elapsed = Date.now() - entry.silencedAt.getTime();
  const remaining = SILENCE_DURATION_MS - elapsed;
  return Math.max(0, remaining);
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
// ENVÍO WHATSAPP VIA ULTRAMSG
// ============================================================
async function enviarWhatsApp(telefono, mensaje) {
  try {
    const url = process.env.ULTRAMSG_URL;
    const token = process.env.ULTRAMSG_TOKEN;
    await axios.post(url, {
      token,
      to: telefono,
      body: mensaje,
      priority: 1,
    }, {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
  } catch (err) {
    console.error(`Error enviando WA a ${telefono}:`, err.message);
  }
}

// ============================================================
// FLUJO PRINCIPAL - PROCESAR MENSAJE ENTRANTE
// ============================================================
async function procesarMensaje(telefono, texto, msgId, fromNumber) {
  texto = texto.trim();

  // ===== VERIFICAR SI EL BOT ESTÁ SILENCIADO PARA ESTE PACIENTE =====
  if (isSilenced(telefono)) {
    const remaining = getTimeUntilRelease(telefono);
    const mins = Math.ceil(remaining / 60000);
    console.log(`🔇 Bot silenciado para ${telefono} - reanuda en ${mins} min`);
    // No respondemos nada - el doctor está atendiendo manualmente
    return;
  }

  let session = sessions.get(telefono);

  // Si no hay sesión o está en estado inicial, mostrar menú
  if (!session || session.state === 'MENU' || session.state === 'IDLE') {
    if (!session) {
      sessions.set(telefono, { state: 'MENU', data: {} });
    }
    sessions.get(telefono).state = 'MENU';
    await enviarWhatsApp(telefono, MENU);
    return;
  }

  const state = session.state;

  switch (state) {

    // ==================== MENÚ PRINCIPAL ====================
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

    // ==================== 1. FLUJO CITAS ====================
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
          const estados = {
            'Pendiente': 'PENDIENTE',
            'Confirmada': 'CONFIRMADA',
            'Completada': 'COMPLETADA',
            'Cancelada': 'CANCELADA'
          };
          msg += `${new Date(c.fecha).toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}\n`;
          msg += `Hora: ${c.hora?.substring(0, 5)}\n`;
          msg += `Dr. ${c.doctor_nombre || 'Asignado'}\n`;
          msg += `${c.centro_nombre}\n`;
          msg += `${c.motivo?.substring(0, 80)}\n`;
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

    // ==================== 2. FLUJO TRATAMIENTOS ====================
    case 'TRATAMIENTOS_CEDULA':
      session.data.cedula = texto;
      const tratamientos = await buscarTratamientosPorCedula(texto);
      if (tratamientos.length === 0) {
        await enviarWhatsApp(telefono, `No tienes tratamientos activos registrados.

0  Volver al menú principal`);
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
          if (horas >= 0 && horas < 999) {
            msg += `  Faltan: ${horas}h ${mins}m\n`;
          }
          msg += `  ${t.centro_nombre}\n\n`;
        }
        msg += '0  Volver al menú principal';
        await enviarWhatsApp(telefono, msg);
      }
      session.state = 'MENU';
      break;

    // ==================== 3. FLUJO AGENDAR CITA ====================
    // PASO 1: Cédula
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

        await enviarWhatsApp(telefono, `Bienvenido de nuevo, ${pacExistente.nombre}${pacExistente.apellido ? ' ' + pacExistente.apellido : ''}!

Tus datos están registrados. Ahora seleccionemos los detalles de tu cita.`);
        // Continuar a seleccionar centro
        session.data.centros = await listarCentros();
        if (session.data.centros.length === 0) {
          await enviarWhatsApp(telefono, 'No hay centros médicos disponibles en este momento. Intenta más tarde.\n0  Volver al menú');
          session.state = 'MENU';
          return;
        }
        let centrosMsg = 'SELECCIONA EL CENTRO MÉDICO\n\n';
        session.data.centros.forEach((c, i) => {
          centrosMsg += `${i + 1}  ${c.nombre}\n`;
          centrosMsg += `   ${c.direccion || ''}\n`;
        });
        centrosMsg += '\nResponde el número del centro:';
        await enviarWhatsApp(telefono, centrosMsg);
        session.state = 'AGENDAR_CENTRO';
      } else {
        // Nuevo paciente - pedir datos completos como en la web
        await enviarWhatsApp(telefono, `No te encontramos registrado. Vamos a crear tu perfil.

Escribe tu NOMBRE completo (nombres y apellidos):`);
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
        if (partes.length === 3) {
          session.data.fecha_nacimiento = `${partes[2]}-${partes[1]}-${partes[0]}`;
        } else {
          session.data.fecha_nacimiento = '';
        }
      } else {
        session.data.fecha_nacimiento = '';
      }
      await enviarWhatsApp(telefono, '¿Cuál es tu GÉNERO?\n\n1  Masculino\n2  Femenino\n3  Otro\n0  Prefiero no decirlo');
      session.state = 'AGENDAR_GENERO';
      break;

    case 'AGENDAR_GENERO':
      const generos = { '1': 'Masculino', '2': 'Femenino', '3': 'Otro', '0': '' };
      session.data.genero = generos[texto] || '';
      // Mostrar centros
      session.data.centros = await listarCentros();
      if (session.data.centros.length === 0) {
        await enviarWhatsApp(telefono, 'No hay centros disponibles.\n0  Volver al menú');
        session.state = 'MENU';
        return;
      }
      let centrosMsg2 = 'SELECCIONA EL CENTRO MÉDICO\n\n';
      session.data.centros.forEach((c, i) => {
        centrosMsg2 += `${i + 1}  ${c.nombre}\n`;
        centrosMsg2 += `   ${c.direccion || ''}\n`;
      });
      centrosMsg2 += '\nResponde el número del centro:';
      await enviarWhatsApp(telefono, centrosMsg2);
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

      // Obtener especialidades
      session.data.especialidades = await listarEspecialidades(session.data.centro_id);
      if (session.data.especialidades.length === 0) {
        await enviarWhatsApp(telefono, `No hay especialidades disponibles en ${session.data.centro_nombre}.

1  Elegir otro centro
0  Volver al menú`);
        session.state = 'AGENDAR_OTRO_CENTRO';
        return;
      }
      let espMsg = `ESPECIALIDADES EN ${session.data.centro_nombre.toUpperCase()}\n\n`;
      session.data.especialidades.forEach((e, i) => {
        espMsg += `${i + 1}  ${e.especialidad}\n`;
      });
      espMsg += '\nResponde el número de la especialidad:';
      await enviarWhatsApp(telefono, espMsg);
      session.state = 'AGENDAR_ESPECIALIDAD';
      break;

    case 'AGENDAR_OTRO_CENTRO':
      if (texto === '1') {
        session.data.centros = await listarCentros();
        let cm = 'SELECCIONA EL CENTRO MÉDICO\n\n';
        session.data.centros.forEach((c, i) => {
          cm += `${i + 1}  ${c.nombre}\n`;
        });
        cm += '\nResponde el número:';
        await enviarWhatsApp(telefono, cm);
        session.state = 'AGENDAR_CENTRO';
      } else {
        session.state = 'MENU';
        await enviarWhatsApp(telefono, MENU);
      }
      break;

    case 'AGENDAR_ESPECIALIDAD':
      const idxEsp = parseInt(texto) - 1;
      if (!session.data.especialidades) {
        session.data.especialidades = await listarEspecialidades(session.data.centro_id);
      }
      if (isNaN(idxEsp) || !session.data.especialidades[idxEsp]) {
        await enviarWhatsApp(telefono, 'Número inválido. Elige una especialidad del listado:');
        return;
      }
      session.data.especialidad = session.data.especialidades[idxEsp].especialidad;

      // Obtener doctores
      session.data.doctores = await listarDoctores(session.data.centro_id, session.data.especialidad);
      if (session.data.doctores.length === 0) {
        await enviarWhatsApp(telefono, `No hay doctores disponibles para ${session.data.especialidad} en ${session.data.centro_nombre}.

1  Elegir otra especialidad
0  Volver al menú`);
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
        let espMsg2 = 'ESPECIALIDADES\n\n';
        session.data.especialidades.forEach((e, i) => {
          espMsg2 += `${i + 1}  ${e.especialidad}\n`;
        });
        espMsg2 += '\nResponde el número:';
        await enviarWhatsApp(telefono, espMsg2);
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

      await enviarWhatsApp(telefono, `Has seleccionado al Dr. ${session.data.doctor_nombre}.

Ahora describe brevemente el MOTIVO DE TU CONSULTA
(ej: dolor de cabeza constante, control mensual, resultados de exámenes, etc.):`);
      session.state = 'AGENDAR_MOTIVO';
      break;

    case 'AGENDAR_MOTIVO':
      session.data.motivo = texto;
      await enviarWhatsApp(telefono, `TIPO DE CONSULTA

1  Presencial - Asistes al consultorio
2  Teleconsulta - Consulta por videollamada
3  A Domicilio - El médico va a tu casa

Responde el número:`);
      session.state = 'AGENDAR_TIPO';
      break;

    case 'AGENDAR_TIPO':
      const tipos = { '1': 'Presencial', '2': 'Teleconsulta', '3': 'Domicilio' };
      if (!tipos[texto]) {
        await enviarWhatsApp(telefono, 'Opción inválida. Responde 1 (Presencial), 2 (Teleconsulta) o 3 (Domicilio):');
        return;
      }
      session.data.tipo_consulta = tipos[texto];
      await enviarWhatsApp(telefono, 'FECHA DE LA CITA\n\nIngresa la fecha deseada en formato DD/MM/AAAA\n(ej: 25/12/2025)\n\nSolo atendemos de lunes a viernes, 8:00 AM - 5:00 PM.');
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
        await enviarWhatsApp(telefono, 'Fecha inválida. Usa DD/MM/AAAA (ej: 25/12/2025):');
        return;
      }
      const hoy = new Date();
      hoy.setHours(0, 0, 0, 0);
      if (fechaDate < hoy) {
        await enviarWhatsApp(telefono, 'La fecha ya pasó. Ingresa una fecha FUTURA (DD/MM/AAAA):');
        return;
      }
      const diaSem = fechaDate.getDay();
      if (diaSem === 0 || diaSem === 6) {
        await enviarWhatsApp(telefono, 'Solo atendemos de LUNES A VIERNES. Ingresa un día de semana (DD/MM/AAAA):');
        return;
      }
      session.data.fecha = fechaStr;

      // Obtener horas disponibles
      const horas = await obtenerHorasDisponibles(session.data.centro_id, session.data.doctor_id, fechaStr);
      if (horas.length === 0) {
        await enviarWhatsApp(telefono, `No hay horas disponibles para el ${texto}.

1  Elegir otra fecha
0  Volver al menú`);
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

      // CONFIRMAR
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
      confMsg += `¿Confirmas y agendamos tu cita?\n\n1  SÍ, confirmar cita\n2  NO, cancelar y volver al menú`;
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

            await enviarWhatsApp(telefono, `CITA AGENDADA CON ÉXITO

Fecha: ${fechaOk}
Hora: ${horaOk}
Doctor: Dr. ${session.data.doctor_nombre}
Centro: ${session.data.centro_nombre}
Tipo: ${session.data.tipo_consulta}

Recibirás un recordatorio 24 horas antes de tu cita.

IMPORTANTE: Debes llegar 30 minutos antes de la hora agendada.

Si necesitas reagendar o cancelar, comunícate al teléfono del centro.

0  Volver al menú principal`);

            // NOTIFICAR AL MÉDICO
            const docInfo = await buscarDoctor(session.data.doctor_id);
            const telMedico = process.env.TELEFONO_MEDICO;

            if (docInfo && docInfo.telefono) {
              await enviarWhatsApp(docInfo.telefono, `NUEVA CITA AGENDADA

Paciente: ${session.data.nombre} ${session.data.apellido || ''}
Cédula: ${session.data.cedula}
Tel: ${session.data.telefono_paciente}
Fecha: ${fechaOk}
Hora: ${horaOk}
Motivo: ${session.data.motivo}
Tipo: ${session.data.tipo_consulta}
Centro: ${session.data.centro_nombre}`);
            }
            if (telMedico && (!docInfo || docInfo.telefono !== telMedico)) {
              await enviarWhatsApp(telMedico, `NUEVA CITA

Paciente: ${session.data.nombre} ${session.data.apellido || ''}
Cédula: ${session.data.cedula}
Tel: ${session.data.telefono_paciente}
Doctor: Dr. ${session.data.doctor_nombre}
Fecha: ${fechaOk}
Hora: ${horaOk}
Centro: ${session.data.centro_nombre}
Motivo: ${session.data.motivo}`);
            }
          } else {
            await enviarWhatsApp(telefono, `Error al agendar la cita: ${result.error}

0  Volver al menú principal`);
          }
        } catch (err) {
          await enviarWhatsApp(telefono, `Error del sistema. Intenta más tarde.

0  Volver al menú principal`);
        }
      } else {
        await enviarWhatsApp(telefono, 'Cita cancelada. No se realizó ningún registro.

0  Volver al menú principal');
      }
      session.state = 'MENU';
      break;

    // ==================== 4. FLUJO RECETAS ====================
    case 'RECETAS_CEDULA':
      session.data.cedula = texto;
      const recetas = await buscarRecetasPorCedula(texto);
      if (recetas.length === 0) {
        await enviarWhatsApp(telefono, `No tienes recetas electrónicas registradas.

0  Volver al menú principal`);
      } else {
        let msg = `MIS RECETAS (${recetas.length})\n\n`;
        for (const r of recetas) {
          msg += `Fecha: ${new Date(r.fecha_emision).toLocaleDateString('es-VE')}\n`;
          msg += `Diagnóstico: ${r.diagnostico}\n`;
          if (r.cie10) msg += `CIE-10: ${r.cie10}\n`;
          msg += `Doctor: Dr. ${r.doctor_nombre || ''}\n`;
          msg += `${r.centro_nombre}\n`;
          try {
            const meds = JSON.parse(r.medicamentos || '[]');
            if (meds.length > 0) {
              msg += `Medicamentos:\n`;
              meds.forEach(m => {
                msg += `  - ${m.nombre} ${m.dosis} c/${m.frecuencia}h\n`;
              });
            }
          } catch (e) {}
          msg += '\n';
        }
        msg += '0  Volver al menú principal';
        await enviarWhatsApp(telefono, msg);
      }
      session.state = 'MENU';
      break;

    // ==================== 5. FLUJO HISTORIAL ====================
    case 'HISTORIAL_CEDULA':
      session.data.cedula = texto;
      const historial = await buscarHistorialPorCedula(texto);
      if (historial.length === 0) {
        await enviarWhatsApp(telefono, `No tienes registros en tu historial clínico.

0  Volver al menú principal`);
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

    // ==================== 6. MENSAJE AL MÉDICO ====================
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

      const msgMedico = `MENSAJE DE PACIENTE

Paciente: ${nombrePac}
Teléfono: ${telPac}
Cédula: ${texto}

Mensaje:
"${session.data.mensaje}"

Fecha: ${new Date().toLocaleString('es-VE')}

IMPORTANTE: El bot ha sido silenciado para este paciente. Responde directamente a ${telPac} y el bot se reactivará automáticamente en 1 hora.`;

      // Enviar al médico principal
      if (process.env.TELEFONO_MEDICO) {
        await enviarWhatsApp(process.env.TELEFONO_MEDICO, msgMedico);
      }

      // También al doctor asignado
      if (pac && pac.doctor_id) {
        const docAsignado = await buscarDoctor(pac.doctor_id);
        if (docAsignado && docAsignado.telefono) {
          await enviarWhatsApp(docAsignado.telefono, msgMedico);
        }
      }

      // SILENCIAR EL BOT PARA ESTE PACIENTE - el médico tomará el control
      silencePatient(telefono, 'MENSAJE_MEDICO');
      if (process.env.TELEFONO_MEDICO) {
        await enviarWhatsApp(process.env.TELEFONO_MEDICO, `🔇 Bot silenciado automáticamente para ${nombrePac} (${telefono}). Responde directamente a este número. El bot se reactivará en 1 hora.`);
      }

      await enviarWhatsApp(telefono, `Mensaje enviado al médico. Te responderá a la brevedad.

Mientras tanto, el doctor tiene el control de la conversación.

0  Volver al menú principal`);
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
           cen.nombre AS centro_nombre, d.nombre AS doctor_nombre,
           d.especialidad
    FROM citas c
    JOIN pacientes p ON c.paciente_id = p.id
    JOIN centros_medicos cen ON c.centro_id = cen.id
    LEFT JOIN doctores d ON c.doctor_id = d.id
    WHERE p.cedula = ? AND p.activo = 1
    ORDER BY c.fecha DESC, c.hora DESC
    LIMIT 10
  `, [cedula]);
  return rows;
}

async function buscarTratamientosPorCedula(cedula) {
  const [rows] = await pool.query(`
    SELECT t.nombre_tratamiento, t.dosis, t.frecuencia_horas, t.proxima_toma,
           t.indicaciones, t.recordatorio_whatsapp, t.activo,
           cen.nombre AS centro_nombre
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
    SELECT h.tipo, h.descripcion, h.observaciones, h.fecha,
           cen.nombre AS centro_nombre
    FROM historial_clinico h
    JOIN pacientes p ON h.paciente_id = p.id
    JOIN centros_medicos cen ON h.centro_id = cen.id
    WHERE p.cedula = ? AND p.activo = 1
    ORDER BY h.fecha DESC LIMIT 15
  `, [cedula]);
  return rows;
}

async function buscarDoctor(doctorId) {
  const [rows] = await pool.query(`
    SELECT id, nombre, email, telefono FROM doctores WHERE id = ? AND activo = 1 LIMIT 1
  `, [doctorId]);
  return rows.length > 0 ? rows[0] : null;
}

async function listarCentros() {
  const [rows] = await pool.query(`
    SELECT id, nombre, direccion, telefono, horario_atencion
    FROM centros_medicos WHERE activo = 1 ORDER BY nombre
  `);
  return rows;
}

async function listarEspecialidades(centroId) {
  const [rows] = await pool.query(`
    SELECT DISTINCT d.especialidad FROM doctores d
    JOIN doctor_centros dc ON d.id = dc.doctor_id
    WHERE dc.centro_id = ? AND d.activo = 1 AND dc.activo = 1
      AND d.especialidad IS NOT NULL
    ORDER BY d.especialidad
  `, [centroId]);
  return rows;
}

async function listarDoctores(centroId, especialidad) {
  const [rows] = await pool.query(`
    SELECT d.id, d.nombre, d.especialidad, d.registro_medico
    FROM doctores d
    JOIN doctor_centros dc ON d.id = dc.doctor_id
    WHERE dc.centro_id = ? AND d.especialidad = ?
      AND d.activo = 1 AND dc.activo = 1
    ORDER BY d.nombre
  `, [centroId, especialidad]);
  return rows;
}

async function obtenerHorasDisponibles(centroId, doctorId, fecha) {
  const diaSemana = new Date(fecha + 'T12:00:00').getDay();

  const [horarios] = await pool.query(`
    SELECT MIN(hora_inicio) as hora_inicio, MAX(hora_fin) as hora_fin,
           MIN(pausa_inicio) as pausa_inicio, MAX(pausa_fin) as pausa_fin,
           MIN(hora_inicio_tarde) as hora_inicio_tarde,
           MAX(hora_fin_tarde) as hora_fin_tarde
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
      for (let i = hit; i < hft; i++) {
        horas.push(`${String(i).padStart(2, '0')}:00:00`);
      }
    }
  } else {
    for (let i = 8; i < 12; i++) horas.push(`${String(i).padStart(2, '0')}:00:00`);
    for (let i = 14; i < 17; i++) horas.push(`${String(i).padStart(2, '0')}:00:00`);
  }

  const [ocupadas] = await pool.query(`
    SELECT hora FROM citas
    WHERE doctor_id = ? AND centro_id = ? AND fecha = ?
      AND estado NOT IN ('Completada', 'Cancelada')
  `, [doctorId, centroId, fecha]);

  const horasOcupadas = new Set(ocupadas.map(r => r.hora));
  return [...new Set(horas)].filter(h => !horasOcupadas.has(h)).sort();
}

async function crearCita(data) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    let [pacientes] = await conn.query(
      'SELECT id FROM pacientes WHERE cedula = ? AND activo = 1 LIMIT 1',
      [data.cedula]
    );
    let pacienteId;

    if (pacientes.length > 0) {
      pacienteId = pacientes[0].id;
      // Actualizar datos si es necesario
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
        `INSERT INTO pacientes (centro_id, doctor_id, nombre, apellido, cedula,
         telefono, email, direccion, fecha_nacimiento, genero, password, username, activo)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
        [data.centro_id, data.doctor_id, data.nombre, data.apellido || '',
         data.cedula, data.telefono_paciente || telefono, data.email || '',
         data.direccion || '', data.fecha_nacimiento || null, data.genero || '',
         hash, username]
      );
      pacienteId = result.insertId;
    }

    const [result] = await conn.query(
      `INSERT INTO citas (centro_id, doctor_id, paciente_id, fecha, hora,
       motivo, tipo_consulta, estado)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'Pendiente')`,
      [data.centro_id, data.doctor_id, pacienteId,
       data.fecha, data.hora, data.motivo, data.tipo_consulta]
    );

    // Registrar en historial clínico
    await conn.query(
      `INSERT INTO historial_clinico (centro_id, paciente_id, doctor_id, tipo,
       descripcion, observaciones)
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
    const inicioStr = ahora.toISOString().slice(0, 19).replace('T', ' ');
    const finStr = dentroDe1h.toISOString().slice(0, 19).replace('T', ' ');

    const [rows] = await pool.query(`
      SELECT t.*, p.nombre AS paciente_nombre, p.telefono,
             c.nombre AS centro_nombre
      FROM tratamientos t
      JOIN pacientes p ON t.paciente_id = p.id
      JOIN centros_medicos c ON t.centro_id = c.id
      WHERE t.proxima_toma BETWEEN ? AND ?
        AND t.recordatorio_whatsapp = 'SI' AND t.activo = 1
    `, [inicioStr, finStr]);

    for (const t of rows) {
      // No enviar recordatorio si el bot está silenciado para este paciente
      if (isSilenced(t.telefono)) {
        console.log(`Saltando recordatorio para ${t.paciente_nombre} - bot silenciado`);
        continue;
      }

      const msg = `RECORDATORIO DE MEDICACIÓN

Hola ${t.paciente_nombre}, es hora de tu tratamiento:

${t.nombre_tratamiento}
Dosis: ${t.dosis}
${t.centro_nombre}

Hora: ${new Date(t.proxima_toma).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })}

Si ya tomaste tu medicamento, ignora este mensaje.`;

      await enviarWhatsApp(t.telefono, msg);
      console.log(`Recordatorio enviado a ${t.paciente_nombre} (${t.telefono}) - ${t.nombre_tratamiento}`);

      const nuevaToma = new Date(t.proxima_toma);
      nuevaToma.setHours(nuevaToma.getHours() + t.frecuencia_horas);
      await pool.query('UPDATE tratamientos SET proxima_toma = ? WHERE id = ?',
        [nuevaToma.toISOString().slice(0, 19).replace('T', ' '), t.id]);
    }

    return rows.length;
  } catch (err) {
    console.error('Error recordatorios tratamientos:', err.message);
    return 0;
  }
}

async function enviarRecordatoriosCitas() {
  try {
    const manana = new Date();
    manana.setDate(manana.getDate() + 1);
    const fechaStr = manana.toISOString().slice(0, 10);

    const [rows] = await pool.query(`
      SELECT c.id, c.fecha, c.hora, c.motivo, c.estado, c.tipo_consulta,
             p.nombre AS paciente_nombre, p.telefono,
             cen.nombre AS centro_nombre, d.nombre AS doctor_nombre
      FROM citas c
      JOIN pacientes p ON c.paciente_id = p.id
      JOIN centros_medicos cen ON c.centro_id = cen.id
      LEFT JOIN doctores d ON c.doctor_id = d.id
      WHERE c.fecha = ? AND c.estado IN ('Pendiente', 'Confirmada')
    `, [fechaStr]);

    for (const c of rows) {
      if (isSilenced(c.telefono)) {
        console.log(`Saltando recordatorio cita para ${c.paciente_nombre} - bot silenciado`);
        continue;
      }

      const msg = `RECORDATORIO DE CITA MÉDICA

Hola ${c.paciente_nombre}, te recordamos que MAÑANA tienes una cita:

Centro: ${c.centro_nombre}
Doctor: Dr. ${c.doctor_nombre || 'Asignado'}
Fecha: ${new Date(c.fecha + 'T12:00:00').toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
Hora: ${c.hora?.substring(0, 5)}
Motivo: ${c.motivo}
Tipo: ${c.tipo_consulta}

Debes llegar 30 MINUTOS ANTES.

Si no puedes asistir, por favor cancela con anticipación.`;

      await enviarWhatsApp(c.telefono, msg);
      console.log(`Recordatorio cita enviado a ${c.paciente_nombre} (${c.telefono})`);
    }

    return rows.length;
  } catch (err) {
    console.error('Error recordatorios citas:', err.message);
    return 0;
  }
}

// ============================================================
// LIMPIEZA DE SESIONES EXPIRADAS (cada 10 min)
// ============================================================
function limpiarSesiones() {
  const now = Date.now();
  for (const [telefono, session] of sessions) {
    if (session.lastActivity && (now - session.lastActivity) > 30 * 60 * 1000) {
      sessions.delete(telefono);
    } else if (session.lastActivity) {
      session.lastActivity = now;
    }
  }
  // Limpiar silencios expirados
  for (const [telefono, entry] of silenced) {
    if ((now - entry.silencedAt.getTime()) >= SILENCE_DURATION_MS) {
      silenced.delete(telefono);
      console.log(`🔊 Silencio expirado para ${telefono}`);
    }
  }
}

setInterval(limpiarSesiones, 10 * 60 * 1000);

// ============================================================
// RUTAS DEL SERVIDOR
// ============================================================

// Webhook principal - mensajes entrantes de WhatsApp
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body?.data || req.body;
    const telefono = (body.from || body.fromMe || '').replace(/\s/g, '');
    const texto = body.body || body.message || '';
    const msgId = body.id || '';

    if (!telefono || !texto) {
      return res.status(200).json({ ok: false, msg: 'No message data' });
    }

    console.log(`📩 WA de ${telefono}: "${texto.substring(0, 80)}"`);

    if (body.fromMe || body.author === 'me') {
      return res.status(200).json({ ok: true });
    }

    setImmediate(() => {
      procesarMensaje(telefono, texto, msgId, body.from || '').catch(err => {
        console.error('Error procesando mensaje:', err.message);
      });
    });

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Error webhook:', err);
    res.status(200).json({ ok: false });
  }
});

// Webhook alternativo UltraMsg
app.post('/webhook-ultramsg', async (req, res) => {
  try {
    const data = req.body?.data || req.body;
    const telefono = (data?.from || '').replace(/\s/g, '');
    const texto = data?.body || '';

    if (telefono && texto) {
      console.log(`📩 WA-UltraMsg de ${telefono}: "${texto.substring(0, 80)}"`);
      setImmediate(() => {
        procesarMensaje(telefono, texto, data?.id || '').catch(err => {
          console.error('Error:', err.message);
        });
      });
    }

    res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Error webhook ultramsg:', err);
    res.status(200).json({ ok: true });
  }
});

// ===== ENDPOINTS DE SILENCIO/ACTIVACIÓN =====

// Silenciar bot para un paciente (lo llama el doctor o el PHP)
app.post('/silence', async (req, res) => {
  const apiKey = req.query.key || req.headers['x-api-key'] || req.body?.key;
  if (apiKey !== process.env.BOT_API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  const { telefono, motivo } = req.body || {};
  if (!telefono) {
    return res.status(400).json({ error: 'Missing telefono' });
  }
  silencePatient(telefono, motivo || 'API');
  res.json({
    ok: true,
    telefono,
    action: 'silenced',
    autoReleaseIn: `${SILENCE_DURATION_MS / 60000} minutes`,
  });
});

// Reactivar bot para un paciente
app.post('/release', async (req, res) => {
  const apiKey = req.query.key || req.headers['x-api-key'] || req.body?.key;
  if (apiKey !== process.env.BOT_API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  const { telefono } = req.body || {};
  if (!telefono) {
    return res.status(400).json({ error: 'Missing telefono' });
  }
  releasePatient(telefono);
  if (req.body?.mensaje) {
    await enviarWhatsApp(telefono, req.body.mensaje);
  }
  res.json({
    ok: true,
    telefono,
    action: 'released',
  });
});

// Estado del silencio
app.get('/silence-status', async (req, res) => {
  const apiKey = req.query.key || req.headers['x-api-key'];
  if (apiKey !== process.env.BOT_API_KEY) {
    return res.status(403).json({ error: 'Invalid API key' });
  }
  const status = {};
  for (const [tel, entry] of silenced) {
    const remaining = SILENCE_DURATION_MS - (Date.now() - entry.silencedAt.getTime());
    status[tel] = {
      silencedAt: entry.silencedAt.toISOString(),
      silencedBy: entry.silencedBy,
      remainingMs: Math.max(0, remaining),
      remainingMin: Math.ceil(Math.max(0, remaining) / 60000),
    };
  }
  res.json({ ok: true, count: silenced.size, silenced: status });
});

// Recordatorios (cronjob)
app.get('/remind', async (req, res) => {
  try {
    const apiKey = req.query.key || req.headers['x-api-key'];
    if (apiKey !== process.env.BOT_API_KEY) {
      return res.status(403).json({ error: 'Invalid API key' });
    }
    const tratamientos = await enviarRecordatoriosTratamientos();
    const citas = await enviarRecordatoriosCitas();
    res.json({
      ok: true,
      recordatorios_tratamientos: tratamientos,
      recordatorios_citas: citas,
      silenced_count: silenced.size,
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('Error cron remind:', err);
    res.status(500).json({ error: err.message });
  }
});

// Webhook para que el PHP notifique eventos al bot
app.post('/notify', async (req, res) => {
  try {
    const apiKey = req.query.key || req.headers['x-api-key'] || req.body?.key;
    if (apiKey !== process.env.BOT_API_KEY) {
      return res.status(403).json({ error: 'Invalid API key' });
    }
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

// Health check
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    uptime: process.uptime(),
    sesiones_activas: sessions.size,
    pacientes_silenciados: silenced.size,
    timestamp: new Date().toISOString(),
  });
});

// ============================================================
// INICIO DEL SERVIDOR
// ============================================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log('╔══════════════════════════════════╗');
  console.log('║   WHATSAPP BOT - CONSULTORIO     ║');
  console.log('╚══════════════════════════════════╝');
  console.log(` Puerto:        ${PORT}`);
  console.log(` Sesiones:      ${sessions.size}`);
  console.log(` Silenciados:   ${silenced.size}`);
  console.log(` Duración silencio: ${SILENCE_DURATION_MS / 60000} min`);
  console.log('');
  console.log(' Endpoints:');
  console.log(`  Webhook:     POST /webhook`);
  console.log(`  Silenciar:   POST /silence`);
  console.log(`  Reactivar:   POST /release`);
  console.log(`  Estado:      GET  /silence-status`);
  console.log(`  Recordatorios: GET /remind?key=...`);
  console.log(`  Notificar:   POST /notify`);
  console.log(`  Health:      GET  /health`);
});
