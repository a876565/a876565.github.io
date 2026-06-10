"""Utility functions for downloading and updating prices."""
from __future__ import annotations
import json
import os
import shutil
import time
from zipfile import ZipFile
import requests

FETCH_INTERVAL = 600#4*3600
MAX_HISTORY = 7 * 24 * 3600
RETRY_COUNT = 3
MIN_INTERVAL = 60
IMAGE_PATH='https://poe.ninja'
ITEM_PATH='https://poe.ninja/{game_version}/api/economy/stash/current/item/overview?league={league}&type={item_type}'
CURRENCIES_PATH='https://poe.ninja/{game_version}/api/economy/exchange/current/overview?league={league}&type={item_type}'
GAME_VERSION='poe2'
LEAGUE="Runes of Aldur"
if GAME_VERSION=='poe':
    DATA_FOLDER='data'
    BACKUP_FOLDER='backup'
    PRICE_FILE='prices_poe.json'
    ITEMS=[
        'Scarab',
        'UniqueAccessory',
        'UniqueArmour',
        'UniqueFlask',
        'UniqueJewel',
        'UniqueWeapon',
        'DivinationCard',
    ]
    CURRENCIES=[
        'Currency',
        'Fragment',
    ]
elif GAME_VERSION=='poe2':
    DATA_FOLDER='data2'
    BACKUP_FOLDER='backup2'
    PRICE_FILE='prices_poe2.json'
    ITEMS=[
    ]
    CURRENCIES=[
        'Currency',
        'Fragments',
        'Abyss',
        'UncutGems',
        'LineageSupportGems',
        'Essences',
        'SoulCores',
        'Idols',
        'Runes',
        'Ritual',
        'Expedition',
        'Delirium',
        'Breach',
        'Verisium',
    ]
else:
    print('Unknown game version',GAME_VERSION)
    exit(-1)
    
def download_url_to_file(url: str, dest_path: str | None = None, chunk_size: int = 8192, timeout: int = 10, session: requests.Session|None = None):
    """
    Download a URL, optionally saving to a local file.

    Returns the response data on success, None on failure.
    """
    close_session = False
    if session is None:
        session = requests.Session()
        close_session = True

    try:
        with session.get(url, stream=True, timeout=timeout) as resp:
            resp.raise_for_status()
            data = resp.content
            if dest_path is not None:
                os.makedirs(os.path.dirname(dest_path) or ".", exist_ok=True)
                with open(dest_path, "wb") as f:
                    f.write(data)
        return data
    except Exception:
        return None
    finally:
        if close_session:
            session.close()
            
def fetch_data(item_type:str,league:str,is_currency=True,game_version='poe2'):
    base_path = CURRENCIES_PATH if is_currency else ITEM_PATH
    url= base_path.format(game_version=game_version,league=league.replace(' ','+'),item_type=item_type)
    dest_path = f'{DATA_FOLDER}/{item_type}.json'
    
    for attempt in range(RETRY_COUNT):
        if content:=download_url_to_file(url, dest_path):
            print(f'Successfully downloaded {item_type} data (Size={len(content)}).')
            return content
        print(f'Attempt {attempt+1}/{RETRY_COUNT} failed for {item_type}.')
    print(f'Failed to download {item_type} data after {RETRY_COUNT} attempts. (URL={url})')
    return None

def is_cache_valid() -> bool:
 
    required_files = [f'{DATA_FOLDER}/{c}.json' for c in CURRENCIES]
    required_files.append(PRICE_FILE)
    
    for f in required_files:
        if not os.path.exists(f):
            return False
        if time.time() - os.path.getmtime(f) >= FETCH_INTERVAL:
            return False
    return True

def backup_old_data() -> None:
    with open(PRICE_FILE, 'r') as f:
        date_ts = json.load(f)['date']
    
    os.makedirs(BACKUP_FOLDER, exist_ok=True)
    
    with ZipFile(f'{BACKUP_FOLDER}/prices_{date_ts}.zip', 'w') as zf:
        zf.write(PRICE_FILE)
        for c in CURRENCIES:
            zf.write(f'{DATA_FOLDER}/{c}.json')

def load_history_from_backups(current_time: int) -> dict[str, dict[str, dict]]:
    history: dict[str, dict[str, dict]] = {}
    if not os.path.exists(BACKUP_FOLDER):
        return history
    
    for filename in os.listdir(BACKUP_FOLDER):
        if not filename.startswith('prices_') or not filename.endswith('.zip'):
            continue
        
        ts_str = filename[7:-4]
        try:
            timestamp = int(ts_str)
        except ValueError:
            continue
        
        if current_time - timestamp >= MAX_HISTORY:
            continue
        
        filepath = os.path.join(BACKUP_FOLDER, filename)
        try:
            with ZipFile(filepath, 'r') as zf:
                with zf.open(PRICE_FILE) as f:
                    prices = json.load(f)
        except Exception:
            continue
        
        for item_id, item_data in prices.get('currencies', {}).items():
            if item_id not in history:
                history[item_id] = {}
            history[item_id][str(timestamp)] = {
                'divineValue': item_data.get('divineValue', 0),
                'exaltedValue': item_data.get('exaltedValue', 0),
                'chaosValue': item_data.get('chaosValue', 0),
            }
    
    return history

def merge_history(items: dict, backup_history: dict[str, dict[str, dict]], 
                  current_prices: dict[str, dict], old_timestamp: int,
                  current_time: int) -> None:
    for item_id, item in items.items():
        if 'history' not in item:
            item['history'] = {}
        
        if item_id in backup_history:
            for ts, values in backup_history[item_id].items():
                if current_time - int(ts) < MAX_HISTORY:
                    item['history'][ts] = values
        
        if item_id in current_prices:
            old_item = current_prices[item_id]
            item['history'][str(old_timestamp)] = {
                'divineValue': old_item.get('divineValue', 0),
                'exaltedValue': old_item.get('exaltedValue', 0),
                'chaosValue': old_item.get('chaosValue', 0),
            }
        
        item['history'] = {
            ts: v for ts, v in item['history'].items()
            if current_time - int(ts) < MAX_HISTORY
        }

def parse_price_data(content:str,rate:dict[str,float]|None=None,catagory:str=''):
    data=json.loads(content)
    core=data['core']
    lines=data['lines']
    items=data['items']
    if rate is None:
        rate={
            'exalted':core['rates']['exalted'],
            'chaos':core['rates']['chaos']
        }
    itemdb={}

    for item in items:
        itemdb[item['id']]={
            'name':item['name'],
            'image':item['image'],
            'category':catagory,
            'history':{},
        }
        
    for line in lines:
        item=itemdb[line['id']]
        
        if core['primary']=='divine':
            value=line['primaryValue']
        elif core['primary']=='chaos':
            value=line['primaryValue']/rate['chaos']
        elif core['primary']=='exalted':
            value=line['primaryValue']/rate['exalted']
        item['divineValue']=value
        item['exaltedValue']=value*rate['exalted']
        item['chaosValue']=value*rate['chaos']
        
        item['maxVolumeCurrency']=line['maxVolumeCurrency']
    return itemdb,rate
    
print('Checking cache...')
if not is_cache_valid():
    current_time = int(time.time())
    old_prices = {}
    old_timestamp = 0
    
    if os.path.exists(PRICE_FILE):
        with open(PRICE_FILE, 'r') as f:
            old_data = json.load(f)
            old_timestamp = old_data.get('date', 0)
            old_prices = old_data.get('currencies', {})
        print('Backing up old data...')
        backup_old_data()
    
    print('Loading history from backups...')
    backup_history = load_history_from_backups(current_time)
    
    print('Updating prices...')
    DATA={
        'date':current_time,
        'rate':None,
        'currencies':{},
        'items':{},
    }

    for i in CURRENCIES:
        dest_path = f'{DATA_FOLDER}/{i}.json'
        if os.path.exists(dest_path):
            file_age = time.time() - os.path.getmtime(dest_path)
            if file_age < MIN_INTERVAL:
                print(f'Skipping {i}, file age {file_age:.0f}s < {MIN_INTERVAL}s.')
                with open(dest_path, 'rb') as f:
                    items,rate=parse_price_data(f.read(),DATA['rate'],i)
                if i=='Currency':
                    DATA['rate']=rate
                DATA['currencies'].update(items)
                continue
        
        items,rate=parse_price_data(fetch_data(i,LEAGUE),DATA['rate'],i)
        if i=='Currency':
            DATA['rate']=rate
        DATA['currencies'].update(items)
    
    print('Merging history...')
    merge_history(DATA['currencies'], backup_history, old_prices, old_timestamp, current_time)

    with open(PRICE_FILE,'w') as f:
        json.dump(DATA,f,indent=4)
else:
    print('Cache is still valid, skipping update.')
