// Script independiente para ejecutar recordatorios desde cronjob
// Uso: node cron-reminder.js
// O configurar en cron-job.org para que llame a:
//   GET https://tu-bot.onrender.com/remind?key=TU_API_KEY

require('dotenv').config();
const mysql = require('mysql2/promise');
const axios = require('axios');

async function main() {
  const pool = mysql.createPool({
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    waitForConnections: true,
    connectionLimit: 2,
    charset: 'utf8mb4',
  });

  async function enviarWhatsApp(telefono, mensaje) {
    try {
      await axios.post(process.env.ULTRAMSG_URL, {
        token: process.env.ULTRAMSG_TOKEN,
        to: telefono,
        body: mensaje,
        priority: 1,
      }, {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        timeout: 10000,
      });
    } catch (err) {
      console.error(`Error WA a ${telefono}:`, err.message);
    }
  }

  // Verificar si paciente está silenciado (consulta al servidor principal via API)
  // Para simplificar, verificamos localmente con una consulta
  // NOTA: Si corres esto como script separado, no tiene acceso a la memoria del servidor.
  // Mejor usa el endpoint /remind del servidor principal.

  console.log('Este script ahora es solo referencia. Usa el endpoint:');
  console.log('GET https://tu-bot.onrender.com/remind?key=TU_API_KEY');
  console.log('');
  console.log('Configúralo en cron-job.org o similar.');

  // === RECORDATORIOS DE TRATAMIENTOS ===
  const ahora = new Date();
  const dentroDe1h = new Date(ahora.getTime() + 60 * 60 * 1000);
  const inicioStr = ahora.toISOString().slice(0, 19).replace('T', ' ');
  const finStr = dentroDe1h.toISOString().slice(0, 19).replace('T', ' ');

  const [tratamientos] = await pool.query(`
    SELECT t.*, p.nombre AS paciente_nombre, p.telefono, c.nombre AS centro_nombre
    FROM tratamientos t
    JOIN pacientes p ON t.paciente_id = p.id
    JOIN centros_medicos c ON t.centro_id = c.id
    WHERE t.proxima_toma BETWEEN ? AND ?
      AND t.recordatorio_whatsapp = 'SI' AND t.activo = 1
  `, [inicioStr, finStr]);

  for (const t of tratamientos) {
    const msg = `RECORDATORIO DE MEDICACIÓN

Hola ${t.paciente_nombre}, es hora de tu tratamiento:

${t.nombre_tratamiento}
Dosis: ${t.dosis}
${t.centro_nombre}
Hora: ${new Date(t.proxima_toma).toLocaleTimeString('es-VE', { hour: '2-digit', minute: '2-digit' })}

Si ya lo tomaste, ignora este mensaje.`;

    await enviarWhatsApp(t.telefono, msg);
    console.log(`Recordatorio: ${t.paciente_nombre} - ${t.nombre_tratamiento}`);

    const nuevaToma = new Date(t.proxima_toma);
    nuevaToma.setHours(nuevaToma.getHours() + t.frecuencia_horas);
    await pool.query('UPDATE tratamientos SET proxima_toma = ? WHERE id = ?',
      [nuevaToma.toISOString().slice(0, 19).replace('T', ' '), t.id]);
  }

  // === RECORDATORIOS DE CITAS (próximo día) ===
  const manana = new Date();
  manana.setDate(manana.getDate() + 1);
  const fechaStr = manana.toISOString().slice(0, 10);

  const [citas] = await pool.query(`
    SELECT c.*, p.nombre AS paciente_nombre, p.telefono,
           cen.nombre AS centro_nombre, d.nombre AS doctor_nombre
    FROM citas c
    JOIN pacientes p ON c.paciente_id = p.id
    JOIN centros_medicos cen ON c.centro_id = cen.id
    LEFT JOIN doctores d ON c.doctor_id = d.id
    WHERE c.fecha = ? AND c.estado IN ('Pendiente', 'Confirmada')
  `, [fechaStr]);

  for (const c of citas) {
    const msg = `RECORDATORIO DE CITA MÉDICA

Hola ${c.paciente_nombre}, MAÑANA tienes una cita:

Centro: ${c.centro_nombre}
Doctor: Dr. ${c.doctor_nombre || 'Asignado'}
Fecha: ${new Date(c.fecha + 'T12:00:00').toLocaleDateString('es-VE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
Hora: ${c.hora?.substring(0, 5)}
Motivo: ${c.motivo}

Llega 30 MINUTOS ANTES.`;

    await enviarWhatsApp(c.telefono, msg);
    console.log(`Recordatorio cita: ${c.paciente_nombre} - ${c.fecha}`);
  }

  console.log(`Completado: ${tratamientos.length} tratamientos, ${citas.length} citas`);
  await pool.end();
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
