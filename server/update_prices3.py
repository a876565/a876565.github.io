"""Utility functions for downloading and updating prices."""
from __future__ import annotations
import argparse
import json
import os
import time
from zipfile import ZipFile
import requests

#Interval to fetech data
FETCH_INTERVAL = 3600#4*3600
#Local history merged 
MAX_HISTORY = 7 * 24 * 3600
#Retry count for downloading data
RETRY_COUNT = 3
#Min interval between data downloading
MIN_DOWNLOAD_INTERVAL = 600

#URLS
ITEM_PATH='https://poe.ninja/{game_version}/api/economy/stash/current/item/overview?league={league}&type={item_type}'
CURRENCIES_PATH='https://poe.ninja/{game_version}/api/economy/exchange/current/overview?league={league}&type={item_type}'

#Game settings
parser = argparse.ArgumentParser(description='Update POE prices from poe.ninja')
parser.add_argument('--game-version', '-g', choices=['poe1', 'poe2'], default='poe1',
                    help='Game version (default: poe1)')
parser.add_argument('--league', '-l', required=True,
                    help='League name (e.g. "Ancestors" or "Standard")')
args = parser.parse_args()

GAME_VERSION = args.game_version
LEAGUE = args.league

print(f'GAME_VERSION={GAME_VERSION}')
print(f'LEAGUE={LEAGUE}')
if GAME_VERSION=='poe1':
    DATA_FOLDER='data'
    BACKUP_FOLDER='backup'
    PRICE_FOLDER='prices'
    ITEMS=[
        'UniqueAccessory',
        'UniqueArmour',
        'UniqueFlask',
        'UniqueJewel',
        'UniqueWeapon',
    ]
    CURRENCIES=[
        'Currency',
        'Fragment',
        'Tattoo',
        'Omen',
        'DjinnCoin',
        'DivinationCard',
        'Oil',
        'Scarab',
    ]
elif GAME_VERSION=='poe2':
    DATA_FOLDER='data2'
    BACKUP_FOLDER='backup2'
    PRICE_FOLDER='prices2'
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
    ITEMS=[
	]
else:
    print('Unknown game version',GAME_VERSION)
    exit(-1)
    
def download_url_to_file(url: str, dest_path: str | None = None, chunk_size: int = 8192, timeout: int = 10, session: requests.Session|None = None):
    """
    Download a URL, optionally saving to a local file.

    Returns the response data on success, None on failure.
    """
    print(f'Downloading {url}')
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
            
def fetch_data(item_type:str,is_currency=True):
    base_path = CURRENCIES_PATH if is_currency else ITEM_PATH
    url= base_path.format(game_version=GAME_VERSION,league=LEAGUE.replace(' ','+'),item_type=item_type)
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
    required_files += [f'{DATA_FOLDER}/{i}.json' for i in ITEMS]
    required_files += [f'{PRICE_FOLDER}/{c}.json' for c in CURRENCIES]
    required_files += [f'{PRICE_FOLDER}/{i}.json' for i in ITEMS]
    
    for f in required_files:
        if not os.path.exists(f):
            return False
        if time.time() - os.path.getmtime(f) >= FETCH_INTERVAL:
            return False
    return True

def backup_data(timestamp: int) -> None:
    os.makedirs(BACKUP_FOLDER, exist_ok=True)
    
    with ZipFile(f'{BACKUP_FOLDER}/prices_{timestamp}.zip', 'w') as zf:
        for i in CURRENCIES + ITEMS:
            data_path = f'{DATA_FOLDER}/{i}.json'
            price_path = f'{PRICE_FOLDER}/{i}.json'
            if os.path.exists(data_path):
                zf.write(data_path, f'data/{i}.json')
            if os.path.exists(price_path):
                zf.write(price_path, f'prices/{i}.json')

def load_history_from_backups(current_time: int) -> dict[str, dict[str, dict[str, dict]]]:
    history: dict[str, dict[str, dict[str, dict]]] = {}
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
                for i in CURRENCIES + ITEMS:
                    price_path = f'prices/{i}.json'
                    if price_path not in zf.namelist():
                        continue
                    with zf.open(price_path) as f:
                        prices = json.load(f)
                    if i not in history:
                        history[i] = {}
                    for item_id, item_data in prices.get('items', {}).items():
                        if item_id not in history[i]:
                            history[i][item_id] = {}
                        # Add current values at backup timestamp
                        history[i][item_id][str(timestamp)] = {
                            'divineValue': item_data.get('divineValue', 0),
                            'exaltedValue': item_data.get('exaltedValue', 0),
                            'chaosValue': item_data.get('chaosValue', 0),
                        }
                        # Also preserve nested history from the backup
                        for hist_ts, hist_values in item_data.get('history', {}).items():
                            history[i][item_id][hist_ts] = {
                                'divineValue': hist_values.get('divineValue', 0),
                                'exaltedValue': hist_values.get('exaltedValue', 0),
                                'chaosValue': hist_values.get('chaosValue', 0),
                            }
        except Exception:
            continue
    
    return history

def cleanup_old_backups(current_time: int) -> None:
    if not os.path.exists(BACKUP_FOLDER):
        return
    
    for filename in os.listdir(BACKUP_FOLDER):
        if not filename.endswith('.zip'):
            continue
        
        ts_str = filename[filename.rfind('_')+1:-4]
        try:
            timestamp = int(ts_str)
        except ValueError:
            continue
        
        if current_time - timestamp >= MAX_HISTORY:
            filepath = os.path.join(BACKUP_FOLDER, filename)
            try:
                os.remove(filepath)
                print(f'Removed old backup {filename}')
            except Exception:
                pass

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

def parse_currency_price(content:str|bytes,rate:dict[str,float]|None=None,catagory:str=''):
    data=json.loads(content)
    core=data['core']
    lines=data['lines']
    items=data['items']

    #Get rate if necessary
    if rate is None:
        currencies = ['divine','chaos','exalted']
        primary = core['primary']

        rate={}
        if primary!='divine':
            primary_to_divine=core['rates']['divine']
            #update primary rate
            rate[primary]=1/primary_to_divine
        else:
            primary_to_divine=1
        for c in currencies:
            if c=='divine':
                continue
            if c==primary:
                continue
            if c not in core['rates']:
                continue
            #convert primary-rate to divine-rate
            rate[c]=core['rates'][c]/primary_to_divine

    itemdb={}
    #Get name and images
    for item in items:
        itemdb[item['id']]={
            'name':item['name'],
            'image':item.get('image'),
            'category':catagory,
            'history':{},
        }

    #Get prices data
    for line in lines:
        item=itemdb[line['id']]
        
        #Always use divine based value
        if core['primary']=='divine':
            value=line['primaryValue']
        elif core['primary']=='chaos':
            value=line['primaryValue']/rate['chaos']
        elif core['primary']=='exalted':
            value=line['primaryValue']/rate['exalted']
        else:
            #Unknown primary type
            continue
        item['divineValue']=value
        item['exaltedValue']=value*rate['exalted'] if 'exalted' in rate else -1
        item['chaosValue']=value*rate['chaos'] if 'chaos' in rate else -1
        
        item['maxVolumeCurrency']=line['maxVolumeCurrency']
    return itemdb,rate

def parse_item_price(content:str|bytes,rate:dict[str,float],catagory:str=''):
    data=json.loads(content)
    lines=data['lines']

    itemdb={}
    for line in lines:
        item_id=line['detailsId']

        parts=[]
        if variant:=line.get('variant'):
            parts.append(f'({variant})')
        if links:=line.get('links'):
            parts.append(f'/{links}L')
        info=''.join(parts) if parts else None

        item={
            'name':line['name'],
            'image':line.get('icon'),
            'category':catagory,
            'history':{},
            'divineValue':line.get('divineValue',0),
            'exaltedValue':line.get('exaltedValue',0),
            'chaosValue':line.get('chaosValue',0),
        }
        if info:
            item['info']=info
        itemdb[item_id]=item
    return itemdb

def write_price_index() -> None:
    """Write a root-level JSON mapping each price category to its file URL."""
    index_path = f'prices_{GAME_VERSION}.json'
    mapping = {}
    for i in CURRENCIES + ITEMS:
        mapping[i] = f'server/{PRICE_FOLDER}/{i}.json'
    with open(index_path, 'w', encoding='utf-8') as f:
        json.dump(mapping, f, indent=2, ensure_ascii=False)
    print(f'Wrote price index to {index_path}')

print('Checking cache...')
if not is_cache_valid():
    current_time = int(time.time())
    
    print('Updating prices...')
    os.makedirs(PRICE_FOLDER, exist_ok=True)
    
    print('Loading history from backups...')
    backup_history = load_history_from_backups(current_time)
    
    rate=None
    
    for i in CURRENCIES+ITEMS:
        price_path = f'{PRICE_FOLDER}/{i}.json'
        old_prices = {}
        old_timestamp = 0
        
        # Load old price file if exists
        if os.path.exists(price_path):
            with open(price_path, 'r') as f:
                old_data = json.load(f)
                old_timestamp = old_data.get('date', 0)
                old_prices = old_data.get('items', {})
        
        dest_path = f'{DATA_FOLDER}/{i}.json'
        content=None

        #load cache if possible
        if os.path.exists(dest_path):
            file_age = time.time() - os.path.getmtime(dest_path)
            if file_age < MIN_DOWNLOAD_INTERVAL:
                print(f'Skipping {i}, file age {file_age:.0f}s < {MIN_DOWNLOAD_INTERVAL}s.')
                with open(dest_path, 'rb') as f:
                    content=f.read()
        #fetch data if cache invalid
        if content is None:
            content=fetch_data(i,i in CURRENCIES)
        #no data
        if content is None:
            print(f'Failed to load data for {i}')
            continue
        
        if i in CURRENCIES:
            items,rate=parse_currency_price(content,rate,i)
        else:
            items=parse_item_price(content,rate,i)
        
        merge_history(items, backup_history.get(i, {}), old_prices, old_timestamp, current_time)
        
        data={
            'date':current_time,
            'rate':rate,
            'items':items,
        }
        
        with open(price_path,'w') as f:
            json.dump(data,f,indent=4)
    
    print('Backing up data...')
    backup_data(current_time)
    
    print('Cleaning up old backups...')
    cleanup_old_backups(current_time)
else:
    print('Cache is still valid, skipping update.')

print('Writing price index...')
write_price_index()
