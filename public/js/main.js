// function main() {
//     const addBtn = document.querySelector('#addBtn');
//     addBtn.addEventListener('click',handleAddClick);
// }

// async function handleAddClick(evt){
//     evt.preventDefault();
//     document.querySelector(".container__row").append(<h1>Hi</h1>);
// }

// {{currentSongId}}
// 0E6uWutxRjIDhleURR92do
// document.addEventListener("DOMContentLoaded", main);
window.onSpotifyIframeApiReady = (IFrameAPI) => {
    let element = document.getElementById('embed-iframe');
    let options = {
        width: '100%',
        height: '200',
        uri: 'spotify:track:63OemEo5x866TOhGpxfuAz'
    };
    let callback = (EmbeddedController)=>{};
    IFrameAPI.createController(element, options, callback);
};