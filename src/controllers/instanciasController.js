const comunicadosModel = require('../controllers/comunicadosController');

async function comunicadosView(req, res){
    try{
        let listadoComunicados
        res.render();
    } catch (error) {
        console.error(error);
        res.status(500).json({ success: false, error: 1, message: 'Error' });
    }
}

async function nuevoComunicado(req, res){
    try{
        const id_user = req.usdata.id_user;
        const {
            titulo_comunicado,
            texto_comunicado,
            enlace_comunicado,
            f_comunicado,
        } = req.body;

        const files = req.files;
        const images = ["img_principal"]; //Añadir dentro del array otra propiedad de imagenes en caso de haber otra

        for (const img of files){
            if(!['image/png', 'img/jpg', 'image/webp', 'application/pdf'].includes(img.mimetype)) {
                res.status(500).json({ success: false, msg: "Verifique el formato de sus imagenes" });
                return;
            }
        }


    } catch (error) {
        console.log(error);
        res.status(500).json({ success: false, error: 1, message: 'Error'});
    }
}

async function editarComunicado(req, res){
    try{

    } catch (error) {
        console.log(error);
        res.status(500).json({ success: false, error: 1, message: 'Error'});
    }
}

async function borrarComunicado(req, res){
    try{

    } catch (error) {
        console.log(error);
        res.status(500).json({ success: false, error: 1, message: 'Error'});
    }
}

// Comunicados

module.exports = {
    comunicadosView,
    nuevoComunicado
}