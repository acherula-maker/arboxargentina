#!/bin/bash
# Deploy GlobalCargo a Hostinger
# Uso: ./deploy.sh

HOST="212.85.6.152"
PORT="65002"
USER="u504531848"
PASS="Alma3012!"
REMOTE_PATH="/home/u504531848/domains/arboxargentina.com/nodejs"
LOCAL_PATH="/Users/alancherula/Documents/Claude/arboxargentina"

FILES="index.html manifest-core.js server.js package.json package-lock.json logo.jpeg logo-nuevo.png boxes.jpeg privacy-policy.html terms-of-service.html data-deletion.html demo.html home.mp4 madrid.png shenzhen.png"

echo "🚀 Desplegando a Hostinger..."

# Subir archivos principales
for f in $FILES; do
  if [ -f "$LOCAL_PATH/$f" ]; then
    expect -c "
      spawn scp -P $PORT $LOCAL_PATH/$f $USER@$HOST:$REMOTE_PATH/$f
      expect \"password:\"
      send \"$PASS\r\"
      expect eof
    " > /dev/null 2>&1
    echo "  ✓ $f"
  fi
done

# Subir carpeta fotos
expect -c "
  spawn scp -r -P $PORT $LOCAL_PATH/fotos $USER@$HOST:$REMOTE_PATH/
  expect \"password:\"
  send \"$PASS\r\"
  expect eof
" > /dev/null 2>&1
echo "  ✓ fotos/"

# Subir carpeta optimizadas
expect -c "
  spawn scp -r -P $PORT $LOCAL_PATH/optimizadas $USER@$HOST:$REMOTE_PATH/
  expect \"password:\"
  send \"$PASS\r\"
  expect eof
" > /dev/null 2>&1
echo "  ✓ optimizadas/"

# Subir carpeta data (dataset del cotizador de exportación FedEx)
expect -c "
  spawn scp -r -P $PORT $LOCAL_PATH/data $USER@$HOST:$REMOTE_PATH/
  expect \"password:\"
  send \"$PASS\r\"
  expect eof
" > /dev/null 2>&1
echo "  ✓ data/"

# Reiniciar app Node.js
expect -c "
  spawn ssh -p $PORT $USER@$HOST
  expect \"password:\"
  send \"$PASS\r\"
  expect \"$ \"
  send \"touch $REMOTE_PATH/tmp/restart.txt && echo APP_REINICIADA\r\"
  expect \"$ \"
  send \"exit\r\"
  expect eof
" > /dev/null 2>&1

echo ""
echo "✅ Deploy completo. App reiniciada."
echo "   https://arboxargentina.com"
