require('dotenv').config();
const express = require('express');
const session = require('express-session');
const PgSession = require('connect-pg-simple')(session);
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const app = express();
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false });
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '20kb' }));
app.use(express.urlencoded({ extended: false, limit: '20kb' }));
app.use(session({
  store: new PgSession({ pool, createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'development-only-change-this-secret',
  resave: false, saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'strict', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8 }
}));
app.use(express.static(path.join(__dirname, 'public')));
const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
app.use('/api', limiter);

const clean = s => String(s || '').trim();
const phoneOk = p => /^\+?2547\d{8}$/.test(p) || /^07\d{8}$/.test(p);
const normalizePhone = p => p.startsWith('+') ? p : p.startsWith('0') ? '+254' + p.slice(1) : p;
const hash = s => crypto.createHash('sha256').update(s).digest('hex');
const requireUser = (req,res,next) => req.session.user ? next() : res.status(401).json({error:'Please sign in.'});
const requireAdmin = (req,res,next) => req.session.admin ? next() : res.status(403).json({error:'Administrator access required.'});

async function sendSms(phone, message) {
  if (!process.env.AT_API_KEY || !process.env.AT_USERNAME || process.env.OTP_MODE !== 'live') {
    console.log(`[SMS TEST to ${phone}] ${message}`); return {sent:false, mode:'console'};
  }
  const params = new URLSearchParams({ username: process.env.AT_USERNAME, to: phone, message });
  if (process.env.AT_SENDER_ID) params.set('from', process.env.AT_SENDER_ID);
  const response = await fetch('https://api.africastalking.com/version1/messaging', {
    method:'POST', headers:{'apiKey':process.env.AT_API_KEY,'Accept':'application/json','Content-Type':'application/x-www-form-urlencoded'}, body:params
  });
  if (!response.ok) throw new Error('SMS provider returned an error');
  return {sent:true};
}
async function notify(userId, phone, title, body) {
  await pool.query('INSERT INTO notifications(user_id,title,body,channel) VALUES($1,$2,$3,$4)', [userId,title,body,'inbox']);
  try { await sendSms(phone, `Koro Loans KE: ${body}`); } catch(e) { console.error('SMS delivery failed:',e.message); }
}

app.get('/api/health', async (req,res) => { try { await pool.query('SELECT 1'); res.json({ok:true, database:'connected'}); } catch(e) { res.status(503).json({ok:false,database:'unavailable'}); } });

app.post('/api/register', async (req,res) => {
  const name=clean(req.body.fullName), id=clean(req.body.nationalId), rawPhone=clean(req.body.phone), password=String(req.body.password||'');
  if(name.length<3 || !/^\d{7,9}$/.test(id) || !phoneOk(rawPhone) || password.length<10) return res.status(400).json({error:'Enter your full name, valid ID number, Kenyan phone number and a password of at least 10 characters.'});
  const phone=normalizePhone(rawPhone);
  try {
    const pw=await bcrypt.hash(password,12);
    const result=await pool.query('INSERT INTO users(full_name,national_id,phone,password_hash) VALUES($1,$2,$3,$4) RETURNING id,full_name,phone', [name,id,phone,pw]);
    const user=result.rows[0];
    req.session.user={id:user.id,name:user.full_name,phone:user.phone};
    const otp=String(crypto.randomInt(100000,999999));
    await pool.query('INSERT INTO otp_codes(user_id,code_hash,expires_at) VALUES($1,$2,NOW()+INTERVAL \'5 minutes\')',[user.id,hash(otp)]);
    await sendSms(phone,`Your Koro Loans KE verification code is ${otp}. It expires in 5 minutes. Do not share it.`);
    res.status(201).json({message:process.env.OTP_MODE==='live'?'Account created. Enter the SMS code to verify your phone.':'Account created in test mode. Ask the developer to check the server console for the OTP.',testMode:process.env.OTP_MODE!=='live'});
  } catch(e) { if(e.code==='23505') return res.status(409).json({error:'That ID number or phone number is already registered.'}); console.error(e); res.status(500).json({error:'Could not create account.'}); }
});
app.post('/api/verify-phone', requireUser, async(req,res)=>{
  const code=clean(req.body.code);
  const q=await pool.query('SELECT * FROM otp_codes WHERE user_id=$1 AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1',[req.session.user.id]);
  if(!q.rowCount) return res.status(400).json({error:'Code expired. Please contact support to request another.'});
  const otp=q.rows[0];
  if(otp.attempts>=5) return res.status(429).json({error:'Too many attempts. Please try again later.'});
  if(hash(code)!==otp.code_hash){ await pool.query('UPDATE otp_codes SET attempts=attempts+1 WHERE id=$1',[otp.id]); return res.status(400).json({error:'Incorrect verification code.'}); }
  await pool.query('UPDATE users SET phone_verified=TRUE WHERE id=$1',[req.session.user.id]);
  await pool.query('DELETE FROM otp_codes WHERE user_id=$1',[req.session.user.id]);
  await notify(req.session.user.id,req.session.user.phone,'Phone verified','Your phone number has been verified. You can now submit a loan application.');
  res.json({message:'Phone verified.'});
});
app.post('/api/login', async(req,res)=>{
  const phone=normalizePhone(clean(req.body.phone)); const password=String(req.body.password||'');
  const q=await pool.query('SELECT id,full_name,phone,password_hash FROM users WHERE phone=$1',[phone]);
  if(!q.rowCount || !(await bcrypt.compare(password,q.rows[0].password_hash))) return res.status(401).json({error:'Invalid phone number or password.'});
  const u=q.rows[0]; req.session.user={id:u.id,name:u.full_name,phone:u.phone}; res.json({message:'Signed in.'});
});
app.post('/api/logout',(req,res)=>req.session.destroy(()=>res.json({message:'Signed out.'})));
app.get('/api/me',requireUser,async(req,res)=>{const q=await pool.query('SELECT full_name,phone,phone_verified FROM users WHERE id=$1',[req.session.user.id]);res.json(q.rows[0]);});
app.post('/api/applications',requireUser,async(req,res)=>{
  const amount=Number(req.body.amount), income=Number(req.body.monthlyIncome), purpose=clean(req.body.purpose), employment=clean(req.body.employmentStatus);
  if(!Number.isInteger(amount)||amount<5000||amount>100000||!Number.isInteger(income)||income<0||purpose.length<8||employment.length<2) return res.status(400).json({error:'Complete all fields correctly. Loan requests must be KSh 5,000–100,000.'});
  const u=await pool.query('SELECT phone_verified,phone FROM users WHERE id=$1',[req.session.user.id]);
  if(!u.rows[0].phone_verified) return res.status(403).json({error:'Verify your phone number before applying.'});
  const q=await pool.query('INSERT INTO applications(user_id,amount_requested,purpose,monthly_income,employment_status) VALUES($1,$2,$3,$4,$5) RETURNING id',[req.session.user.id,amount,purpose,income,employment]);
  await notify(req.session.user.id,u.rows[0].phone,'Application received',`We have received application #${q.rows[0].id}. It is awaiting review. Submission is not loan approval.`);
  res.status(201).json({message:'Application received.',applicationId:q.rows[0].id});
});
app.get('/api/my-applications',requireUser,async(req,res)=>{const q=await pool.query('SELECT id,amount_requested,status,amount_approved,admin_note,created_at,updated_at FROM applications WHERE user_id=$1 ORDER BY created_at DESC',[req.session.user.id]);res.json(q.rows);});
app.get('/api/notifications',requireUser,async(req,res)=>{const q=await pool.query('SELECT id,title,body,created_at,read_at FROM notifications WHERE user_id=$1 ORDER BY created_at DESC LIMIT 100',[req.session.user.id]);res.json(q.rows);});
app.post('/api/notifications/:id/read',requireUser,async(req,res)=>{await pool.query('UPDATE notifications SET read_at=NOW() WHERE id=$1 AND user_id=$2',[req.params.id,req.session.user.id]);res.json({ok:true});});

app.post('/api/admin/login',async(req,res)=>{
  const email=clean(req.body.email).toLowerCase(), password=String(req.body.password||'');
  const adminEmail=clean(process.env.ADMIN_EMAIL).toLowerCase(), adminPassword=String(process.env.ADMIN_PASSWORD||'');
  if(!adminEmail || !adminPassword || email!==adminEmail || !(await bcrypt.compare(password, await bcrypt.hash(adminPassword, 10)))) return res.status(401).json({error:'Invalid administrator credentials.'});
  req.session.admin={email:adminEmail,name:process.env.ADMIN_NAME||'Administrator'}; res.json({message:'Administrator signed in.'});
});
app.get('/api/admin/applications',requireAdmin,async(req,res)=>{const q=await pool.query(`SELECT a.id,a.amount_requested,a.monthly_income,a.purpose,a.employment_status,a.status,a.amount_approved,a.admin_note,a.created_at,u.full_name,u.national_id,u.phone,u.phone_verified FROM applications a JOIN users u ON u.id=a.user_id ORDER BY a.created_at DESC`);res.json(q.rows);});
app.post('/api/admin/applications/:id/decision',requireAdmin,async(req,res)=>{
  const id=Number(req.params.id), status=clean(req.body.status), note=clean(req.body.note), amount=req.body.amountApproved===undefined?null:Number(req.body.amountApproved);
  if(!Number.isInteger(id)||!['under_review','approved','declined','more_info'].includes(status)) return res.status(400).json({error:'Invalid decision.'});
  if(status==='approved'&&(!Number.isInteger(amount)||amount<5000||amount>100000)) return res.status(400).json({error:'Enter a valid approved amount between KSh 5,000 and KSh 100,000.'});
  if(status!=='approved'&&amount!==null) return res.status(400).json({error:'Approved amount is only allowed for an approval.'});
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    const q=await client.query('SELECT a.*,u.phone,u.full_name FROM applications a JOIN users u ON u.id=a.user_id WHERE a.id=$1 FOR UPDATE',[id]);
    if(!q.rowCount){await client.query('ROLLBACK');return res.status(404).json({error:'Application not found.'});}
    const a=q.rows[0];
    await client.query('UPDATE applications SET status=$1,amount_approved=$2,admin_note=$3,updated_at=NOW() WHERE id=$4',[status,amount,note||null,id]);
    await client.query('INSERT INTO audit_logs(admin_email,application_id,action,details) VALUES($1,$2,$3,$4)',[req.session.admin.email,id,status,JSON.stringify({amountApproved:amount,note})]);
    const message=status==='approved'?`Your application #${id} has been approved for KSh ${amount.toLocaleString('en-KE')}. Review the full written offer and terms before accepting.`:status==='declined'?`Your application #${id} has not been approved. Sign in to view any available information.`:status==='more_info'?`We need additional information for application #${id}. Please sign in to view the request.`:`Your application #${id} is now under review.`;
    await client.query('INSERT INTO notifications(user_id,title,body,channel) VALUES($1,$2,$3,$4)',[a.user_id,'Application update',message,'inbox']);
    await client.query('COMMIT');
    try{await sendSms(a.phone,`Koro Loans KE: ${message}`);}catch(e){console.error('SMS delivery failed:',e.message);}
    res.json({message:'Decision saved and customer inbox updated.'});
  }catch(e){await client.query('ROLLBACK');console.error(e);res.status(500).json({error:'Could not save decision.'});}finally{client.release();}
});
app.post('/api/admin/logout',(req,res)=>req.session.destroy(()=>res.json({message:'Signed out.'})));

app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'public','index.html')));
const port=Number(process.env.PORT||3000);
app.listen(port,()=>console.log(`Koro Loans KE running on port ${port}`));
