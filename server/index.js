const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// 内存数据库持久化房间
const rooms = {};

io.on('connection', (socket) => {
  // Host 创建房间
  socket.on('create_room', ({ roomCode, hostCode }, callback) => {
    if (rooms[roomCode]) {
      return callback({ success: false, message: 'Room Code already exists!' });
    }
    rooms[roomCode] = { hostCode, isCanBuzz: false, players: [], buzzList: [] };
    socket.join(roomCode);
    socket.isHost = true;
    socket.roomCode = roomCode;
    callback({ success: true });
  });

  // Host 登录
  socket.on('host_login', ({ roomCode, hostCode }, callback) => {
    const room = rooms[roomCode];
    if (!room) return callback({ success: false, message: 'Room not found!' });
    if (room.hostCode !== hostCode) return callback({ success: false, message: 'Invalid Security Code!' });

    socket.join(roomCode);
    socket.isHost = true;
    socket.roomCode = roomCode;
    callback({ 
      success: true, 
      roomData: { players: room.players, buzzList: room.buzzList, isCanBuzz: room.isCanBuzz } 
    });
  });

  // Player 加入
  socket.on('join_player', ({ roomCode, name }, callback) => {
    const room = rooms[roomCode];
    if (!room) return callback({ success: false, message: 'Room not found!' });

    socket.join(roomCode);
    socket.playerName = name;
    socket.roomCode = roomCode;

    if (!room.players.includes(name)) room.players.push(name);
    io.to(roomCode).emit('player_list_updated', room.players);
    callback({ success: true, isCanBuzz: room.isCanBuzz });
  });

  // Host 操作：开启/重置/音效
  socket.on('start_round', () => {
    const room = rooms[socket.roomCode];
    if (socket.isHost && room) {
      room.isCanBuzz = true;
      room.buzzList = [];
      io.to(socket.roomCode).emit('round_started');
    }
  });

  socket.on('reset_round', () => {
    const room = rooms[socket.roomCode];
    if (socket.isHost && room) {
      room.isCanBuzz = false;
      room.buzzList = [];
      io.to(socket.roomCode).emit('round_reset');
    }
  });

  socket.on('trigger_effect', (effectType) => {
    if (socket.isHost && socket.roomCode) {
      io.to(socket.roomCode).emit('play_effect', effectType);
    }
  });

  // Player 抢答
  socket.on('press_buzzer', () => {
    const room = rooms[socket.roomCode];
    if (room && room.isCanBuzz) {
      const alreadyBuzzed = room.buzzList.some(b => b.name === socket.playerName);
      if (!alreadyBuzzed) {
        const record = {
          name: socket.playerName,
          time: new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 }),
          rank: room.buzzList.length + 1
        };
        room.buzzList.push(record);
        io.to(socket.roomCode).emit('buzz_update', room.buzzList);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Buzz Lightyear backend running on port ${PORT}`));