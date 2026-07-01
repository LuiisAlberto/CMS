const { parseString, parseStringPromise } = require("xml2js");
const sepCedulasToken = process.env.SEP_CEDULAS_TOKEN;
const sepCedulaApi = 'https://cedulaprofesional.sep.gob.mx/cedula/restful/profesionista/'
// async function renapoConsultarCurp(curp){
//     const url = process.env.END_POINT_RENAPO;
//     try {
//         const response = await fetch( urlRenapo, {
//             method:'POST',
//             body:
//                 `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:web="http://www.example.org/webservice/">
//                     <soapenv:Header/>
//                     <soapenv:Body>
//                         <web:renapoCurp>
//                             <web:curpUrl>${curp}</web:curpUrl>
//                         </web:renapoCurp>
//                     </soapenv:Body>
//                 </soapenv:Envelope>`,
//             headers: {
//                 "Content-Type": "text/xml;charset=UTF-8",
//                 SOAPAction: "renapoCurp",
//             },
//         });
//         const xmlResponse = await response.text();

//         let responseData = false;
//         parseString(xmlResponse, { explicitArray: false }, (err, result) => {
//             if (err) {
//                 console.error("Error al analizar XML:", err);
//             } else {
//                 const items = result["SOAP-ENV:Envelope"]["SOAP-ENV:Body"]["ns1:renapoCurpResponse"]["return"]["item"];
//                 if( items==undefined || items==null ){
//                     console.error('Error en renapoConsultarCurp |---  items==undefined || items==null  ---|  curp: ' + curp);
//                 }else{
//                     responseData = [];
//                     items.forEach( item => {
//                         const key = item["key"]["_"];
//                         const value = item["value"]["_"];
    
//                         // responseData.push({ key, value });
//                         responseData[key] = value;
//                         // console.log(`Key: ${key}, Value: ${value}`);
//                     });
//                 }
//             }
//         });

//         return responseData;

//     } catch (error) {
//         console.error("Error en la solicitud SOAP:", error.message);
//         return false;
//     }
// }
function renapoConsultarCurp(curp){
    const urlRenapo = process.env.END_POINT_RENAPO;
    return  fetch( urlRenapo, {
        method:'POST',
        body:
            `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:web="http://www.example.org/webservice/">
                <soapenv:Header/>
                <soapenv:Body>
                    <web:renapoCurp>
                        <web:curpUrl>${curp}</web:curpUrl>
                    </web:renapoCurp>
                </soapenv:Body>
            </soapenv:Envelope>`,
        headers: {
            'Content-Type': 'text/xml;charset=UTF-8',
            SOAPAction: 'renapoCurp',
        },
    })
    .then( response => response.text() )
    .then(xmlResponse => parseStringPromise(xmlResponse, { explicitArray: false }))
    .then(result=> {
        try{
            const items = result['SOAP-ENV:Envelope']['SOAP-ENV:Body']['ns1:renapoCurpResponse']['return']['item'];
            if( items===undefined || items===null ){
                console.error('Error en renapoConsultarCurp |---  items==undefined || items==null  ---|  curp: ' + curp);
                return false;
            }
            let responseData = [];
            items.forEach( item => {
                const key = item['key']['_'];
                const value = item['value']['_'];

                // responseData.push({ key, value });
                responseData[key] = value;
                // console.log(`Key: ${key}, Value: ${value}`);
            });
            return responseData;
        } catch(error){
            console.error('Error al analizar XML:', err);
            return false;
        }
    })
    .catch( err => {
        console.error('Error en la solicitud SOAP:', err.message);
        return false;
    });
}
async function sepConsultaCedula(cedula){
    if(sepCedulasToken='') throw new Error('SEP_CEDULAS_TOKEN no configurado');
    const url = sepCedulaApi+'porCedula';
    try{
        return await (await fetch(url,{
            method: 'POST',
            body:'{"cedula": "'+cedula+'"}',
            headers: {
                'Content-Type': 'application/json',
                'X-XSRF-TOKEN': sepCedulasToken,
                'Cookie': 'XSRF-TOKEN=' + sepCedulasToken
            }
        })).json();
    }catch (error) {
        console.error('Error en la solicitud cedulaprofesional:', error.message);
        return false;
    }
}
async function sepConsultaCedula_porCurp(curp){
    if(sepCedulasToken='') throw new Error('SEP_CEDULAS_TOKEN no configurado');
    const url = sepCedulaApi+'porCURP';
    try{
        let text = await (await fetch(url,{
            method: 'POST',
            body:'{"curp": "'+curp+'"}',
            headers: {
                'Content-Type': 'application/json',
                'X-XSRF-TOKEN': sepCedulasToken,
                'Cookie': 'XSRF-TOKEN=' + sepCedulasToken
            }
        })).text();
        //console.log(text)
        if(text==null || text=='' || text==false) return false;
        return JSON.parse(text);
    }catch (error) {
        console.error('Error en la solicitud cedulaprofesional:', error.message);
        return false;
    }
}
async function sepConsultaCedula_porNombre(nombre,paterno,materno,genero){
    if(sepCedulasToken='') throw new Error('SEP_CEDULAS_TOKEN no configurado');
    const url = sepCedulaApi+'porNombre';
    try{
        let genero_interno='';
        if(genero=='H'||genero=='h'||genero=='HOMBRE') genero_interno='HOMBRE';
        if(genero=='M'||genero=='m'||genero=='MUJER') genero_interno='MUJER';
        if(genero_interno==''){
            console.error('falta genero en sepConsultaCedula_porNombre');
            return false;
        }
        let text = await (await fetch(url,{
            method: 'POST',
            body: JSON.stringify({
                nombre: nombre,
                primer_apellido: paterno,
                segundo_apellido: materno,
                genero: genero_interno
                }),
            headers: {
                'Content-Type': 'application/json',
                'X-XSRF-TOKEN': sepCedulasToken,
                'Cookie': 'XSRF-TOKEN=' + sepCedulasToken
            }
        })).text();
        //console.log(text)
        if(text==null || text=='' || text==false) return false;
        return JSON.parse(text);
    }catch (error) {
        console.error('Error en la solicitud cedulaprofesional:', error.message);
        return false;
    }
}
async function sepConsultaCedula_porNombre_2(nombre,paterno,materno){//tiene varios errores en las consultas
    
    const url = 'https://www.cedulaprofesional.sep.gob.mx/cedula/buscaCedulaJson.action';
    try{
        return (await (await fetch(url,{
            method: 'POST',
            body: 'json='+JSON.stringify({maxResult:'1000',nombre:nombre,paterno:paterno,materno:materno,idCedula:''}),
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
            }
        })).json()).items;
    }catch (error) {
        console.error('Error en la solicitud cedulaprofesional:', error.message);
        return false;
    }
}
module.exports = {
    renapoConsultarCurp,
    sepConsultaCedula,
    sepConsultaCedula_porCurp,
    sepConsultaCedula_porNombre,
    sepConsultaCedula_porNombre_2,
}